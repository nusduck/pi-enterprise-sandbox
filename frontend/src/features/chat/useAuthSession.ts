/**
 * 会话与身份边界控制器：`me` 检查、登录/注册/退出、config 投影和 401/503 分流。
 *
 * 从 `ChatContext` 抽出的独立职责，也是本阶段（P1b）的行为边界：
 *
 * - **401 ≠ 503**：只有 401 才是匿名身份，执行本机身份清理；503/网络/契约失败
 *   只显示可见错误与重试，保留草稿与已有身份（不主动 logout）。
 * - **me 401 只清本机身份**：不再补发 best-effort `logout`（那是一个可能在新登录
 *   之后才落地的延迟响应，会清掉新会话的 Cookie）；手动退出仍走服务端 revoke。
 * - **退出是身份边界**：即使服务端撤销未确认（409/503/网络），本机用户/流/实体/
 *   附件/会话也全部清掉，只保留「撤销未确认」的可见提示；**不拿可能已切号的
 *   Cookie 自动重试**。
 * - **认证 mutation 串行**：login/register/logout 共用 `createAuthMutationGate`，
 *   快照取值、HTTP 调用与身份落地在同一互斥区段；当前 provider 不会并发写 Cookie，
 *   一次失败也不会卡死后续登录/退出。
 * - **切号才重置**：登录/注册成功前进代次并让调用方清理旧身份数据；失败的登录
 *   不碰当前草稿与数据。
 * - 所有响应落地前核对身份代次与组件存活，过期响应直接丢弃。
 *
 * 完整状态的清理由 ChatContext 提供的 `clearIdentity` 完成（它拥有消息、附件、
 * EntityBridge 等，并负责推进身份代次）；这里只写认证字段。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAuthConfig,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  register as apiRegister,
  type AuthUser,
} from '../../shared/api/auth';
import { ApiError } from '../../shared/api/client';
import {
  AUTH_CONFIG_UNAVAILABLE_MESSAGE,
  AUTH_UNAVAILABLE_MESSAGE,
  ME_SESSION_REJECTED_MESSAGE,
  authFailureMessage,
  classifyAuthFailure,
  unconfirmedLogoutWarning,
  type LogoutRevocation,
} from '../../shared/api/authConfig';
import type { AuthConfig } from '../../shared/schemas/auth';
import { createAuthMutationGate } from './authMutationGate';
import type { IdentityRevision } from './identityRevision';

/**
 * 写回 ChatState 的用户投影；比 API 的 `AuthUser` 宽一档（旧服务端可能只回
 * username），让 ChatContext 不必做类型断言。
 */
export type AuthUserState = { username?: string; [k: string]: unknown } | null;

type ApplyAuth = (patch: {
  authReady?: boolean;
  authUser?: AuthUserState;
  authError?: string | null;
}) => void;

/**
 * `me` 检查的确认结果。只有 `authenticated` 才允许调用方恢复账号作用域的目录/
 * 上次会话；`anonymous` 是本机已清理的匿名态，`unavailable` 是服务不可用
 * （身份未确认，必须保留草稿但**不**恢复旧会话）。
 */
export type AuthCheck =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'anonymous' }
  | { status: 'unavailable' };

export type AuthSessionOptions = {
  /** 当前认证投影（由 ChatContext 从 state 读出）；重试与失败路径读它决定文案。 */
  authUser: AuthUserState;
  authError: string | null;
  authReady: boolean;
  applyAuth: ApplyAuth;
  /** 写认证外的状态：状态栏文案与可见错误提示。 */
  setStatus: (text: string, color?: string) => void;
  flashError: (message: string) => void;
  revision: IdentityRevision;
  /** 身份边界：清空本机用户/流/实体/附件/持久化会话，并前进各自代次。 */
  clearIdentity: (options: { statusLabel: string; statusColor?: string }) => void;
  /** 切换成功后重新拉当前身份的会话/模型/Agent 目录。 */
  afterIdentitySwitch: () => Promise<void>;
};

export type AuthSession = {
  authUser: AuthUserState;
  authError: string | null;
  authReady: boolean;
  authConfig: AuthConfig | null;
  configLoading: boolean;
  configError: string | null;
  /** 退出后服务端撤销未确认时的可见提示；普通退出为 null。 */
  logoutWarning: string | null;
  loadConfig: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuthUser: () => Promise<boolean>;
  /**
   * `me` 503/网络失败后的可见重试入口：重跑 config + `me` 检查，并回传这次
   * 是否**确认**了身份，让调用方只在确认后恢复上次聚焦的会话。
   */
  retryAuth: () => Promise<AuthCheck>;
};

export function useAuthSession(options: AuthSessionOptions): AuthSession {
  const {
    authUser,
    authError,
    authReady,
    applyAuth,
    setStatus,
    flashError,
    revision,
    clearIdentity,
    afterIdentitySwitch,
  } = options;

  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [logoutWarning, setLogoutWarning] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** 最新认证投影：401 时用它判断「本来就匿名」还是「会话刚失效」。 */
  const authUserRef = useRef<AuthUserState>(authUser);
  authUserRef.current = authUser;

  /** 登录/注册/退出的互斥闸门；跨渲染稳定，串行化所有认证写请求。 */
  const mutationGateRef = useRef<ReturnType<typeof createAuthMutationGate> | null>(null);
  if (!mutationGateRef.current) mutationGateRef.current = createAuthMutationGate();
  const mutationGate = mutationGateRef.current;

  /** 拉一次登录能力投影。失败**不能**当成「没有登录方式」：保留错误与重试。 */
  const loadConfig = useCallback(async () => {
    const snapshot = revision.current();
    setConfigLoading(true);
    try {
      const config = await getAuthConfig();
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return;
      setAuthConfig(config);
      setConfigError(null);
    } catch (error) {
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return;
      setAuthConfig(null);
      setConfigError(authFailureMessage(classifyAuthFailure(error), AUTH_CONFIG_UNAVAILABLE_MESSAGE));
    } finally {
      if (aliveRef.current && revision.isCurrent(snapshot)) setConfigLoading(false);
    }
  }, [revision]);

  /**
   * `me` 明确拒绝（401）时的本机身份清理：清 Cookie 无关的本机状态并提示重新
   * 登录。**绝不**在这里补发 logout——那个延迟响应可能清掉后来登录的新 Cookie。
   * 代次已变/组件已卸载时什么都不做。
   */
  const handleRejectedIdentity = useCallback((snapshot: number) => {
    if (!aliveRef.current || !revision.isCurrent(snapshot)) return;
    const hadIdentity = Boolean(authUserRef.current?.username);
    clearIdentity({ statusLabel: 'Signed out', statusColor: '#64748b' });
    if (hadIdentity) flashError(ME_SESSION_REJECTED_MESSAGE);
  }, [clearIdentity, flashError, revision]);

  /**
   * 浏览器会话检查。401 → 匿名（只清本机身份）；503/网络 → 可见错误 + 重试，
   * 保留草稿与已有身份。返回**确认结果**，让调用方决定是否恢复账号作用域数据。
   */
  const checkSession = useCallback(async (): Promise<AuthCheck> => {
    const snapshot = revision.current();
    try {
      const user = await apiMe();
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return { status: 'unavailable' };
      applyAuth({ authReady: true, authUser: user, authError: null });
      return { status: 'authenticated', user };
    } catch (error) {
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return { status: 'unavailable' };
      const failure = classifyAuthFailure(error);
      if (failure.kind === 'unauthenticated') {
        handleRejectedIdentity(snapshot);
        return { status: 'anonymous' };
      }
      // 503/网络/契约失败：保留本机状态，只显示错误与重试。
      applyAuth({
        authReady: true,
        authError: authFailureMessage(failure, AUTH_UNAVAILABLE_MESSAGE),
      });
      return { status: 'unavailable' };
    }
  }, [applyAuth, handleRejectedIdentity, revision]);

  /**
   * 登录/注册成功后切号：清旧身份数据（`clearIdentity` 负责前进身份代次），
   * 再拉新身份的目录。`snapshot` 是进入互斥区段时取的代次：期间若已经切过号/
   * 退出，这次响应作废。
   */
  const adoptIdentity = useCallback(
    async (
      snapshot: number,
      user: AuthUser | null,
      fallbackUsername: string,
      successLabel: string,
    ) => {
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return;
      setLogoutWarning(null);
      clearIdentity({ statusLabel: successLabel });
      applyAuth({
        authReady: true,
        authUser: user || { username: fallbackUsername },
        authError: null,
      });
      setStatus(successLabel);
      await afterIdentitySwitch().catch(() => {
        /* 目录拉取失败不该把已经成功的登录退回去；下次刷新会补上。 */
      });
    },
    [afterIdentitySwitch, applyAuth, clearIdentity, revision, setStatus],
  );

  /**
   * 认证写操作的公共外壳：快照取值 / API 调用 / 身份落地全在同一互斥区段，
   * 保证两次登录或登录与退出不会并发改写共享 Cookie。
   */
  const login = useCallback(
    (username: string, password: string) =>
      mutationGate.run(async () => {
        const snapshot = revision.current();
        const data = await apiLogin({ username, password });
        await adoptIdentity(
          snapshot,
          data.user || null,
          username,
          `Logged in as ${data.user?.username || username}`,
        );
      }),
    [adoptIdentity, mutationGate, revision],
  );

  const register = useCallback(
    (username: string, password: string) =>
      mutationGate.run(async () => {
        const snapshot = revision.current();
        const data = await apiRegister({ username, password });
        await adoptIdentity(
          snapshot,
          data.user || null,
          username,
          `Registered as ${data.user?.username || username}`,
        );
      }),
    [adoptIdentity, mutationGate, revision],
  );

  /**
   * 退出：无论服务端撤销确认与否，都清本机身份。撤销未确认只作为可见提示。
   * 这里绝不根据失败自动重试——当前 Cookie 可能已经属于另一个账号。
   * 迟到的退出响应（组件已卸载或身份已切换）不得再清当前身份。
   */
  const logout = useCallback(
    () =>
      mutationGate.run(async () => {
        const snapshot = revision.current();
        let revocation: LogoutRevocation = 'confirmed';
        let code: string | null = null;
        try {
          const outcome = await apiLogout();
          revocation = outcome.revocation;
          code = outcome.code;
        } catch (error) {
          revocation = 'unconfirmed';
          code = error instanceof ApiError ? error.code ?? null : null;
        }
        if (!aliveRef.current || !revision.isCurrent(snapshot)) return;
        clearIdentity({ statusLabel: 'Logged out' });
        if (revocation === 'unconfirmed') {
          const warning = unconfirmedLogoutWarning(code);
          setLogoutWarning(warning);
          flashError(warning);
        } else {
          setLogoutWarning(null);
        }
      }),
    [clearIdentity, flashError, mutationGate, revision],
  );

  /**
   * 重新读一次 `me`。角色权威在服务端，撤销自己的 admin 后要立刻让闸门变 false。
   * 401 → 只清本机身份并提示重新登录；503/网络 → 可见错误，返回 false 让调用方
   * 提示手动重试。
   */
  const refreshAuthUser = useCallback(async (): Promise<boolean> => {
    const snapshot = revision.current();
    try {
      const user = await apiMe();
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return false;
      applyAuth({ authReady: true, authUser: user, authError: null });
      return true;
    } catch (error) {
      if (!aliveRef.current || !revision.isCurrent(snapshot)) return false;
      const failure = classifyAuthFailure(error);
      if (failure.kind === 'unauthenticated') {
        handleRejectedIdentity(snapshot);
        return false;
      }
      const message = authFailureMessage(failure, AUTH_UNAVAILABLE_MESSAGE);
      applyAuth({ authError: message });
      flashError(message);
      return false;
    }
  }, [applyAuth, flashError, handleRejectedIdentity, revision]);

  /**
   * 首次检查与「重试」共用：config + `me` 各拉一次；只有 `me` **确认**身份后
   * 才刷新目录并回传 authenticated，503 不触发任何账号作用域恢复。
   */
  const retryAuth = useCallback(async (): Promise<AuthCheck> => {
    await loadConfig();
    const result = await checkSession();
    if (result.status === 'authenticated') {
      await afterIdentitySwitch().catch(() => {});
    }
    return result;
  }, [afterIdentitySwitch, checkSession, loadConfig]);

  return {
    authUser,
    authError,
    authReady,
    authConfig,
    configLoading,
    configError,
    logoutWarning,
    loadConfig,
    login,
    register,
    logout,
    refreshAuthUser,
    retryAuth,
  };
}
