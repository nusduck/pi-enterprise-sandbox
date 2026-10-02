import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { ssoButtonText } from './ssoButtonText';
import { sanitizeReturnTo } from '../../shared/security/returnTo';
import {
  localLoginErrorMessage,
  ssoLoginUrl,
  takeSsoError,
} from '../../shared/api/sso';
import { loginErrorMessage } from './loginError';
import { noLoginMethodMessage } from '../../shared/schemas/auth';
import s from './loginPage.module.css';

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    state,
    authConfig,
    login,
    register,
    retryAuth,
    logoutWarning,
  } = useChat();

  const returnTo = sanitizeReturnTo(searchParams.get('return_to'));
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [adminFormOpen, setAdminFormOpen] = useState(false);

  // 已登录访问 /login → 跳回 return_to 或 /
  useEffect(() => {
    if (state.authReady && state.authUser?.username) {
      navigate(returnTo, { replace: true });
    }
  }, [state.authReady, state.authUser, navigate, returnTo]);

  // SSO 回调带回的错误 (takeSsoError) 从地址栏提取并展示在表单顶部
  useEffect(() => {
    const errorMsg = takeSsoError();
    if (errorMsg) {
      setSsoError(errorMsg);
    }
  }, []);

  const caps = authConfig.capabilities;

  // SSO 开启但不可用时，默认展开本地管理员登录表单
  useEffect(() => {
    if (caps && caps.ssoEnabled && !caps.ssoAvailable) {
      setAdminFormOpen(true);
    }
  }, [caps]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await login(username.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setFormError(loginErrorMessage(err, '用户名或密码错误'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async () => {
    if (!username.trim() || !password) {
      setFormError('请输入用户名和密码以完成注册');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await register(username.trim(), password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setFormError(loginErrorMessage(err, '注册失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const ssoUrl = ssoLoginUrl(returnTo);

  return (
    <div className={s.page}>
      {/* 左栏深色品牌区（窄屏 <900px 隐藏） */}
      <aside className={s.brandCol} aria-label="产品介绍">
        <div className={s.brandHeader}>
          <div className={s.logoIcon} aria-hidden="true">UR</div>
          <div className={s.brandTitle}>UPRC Agent</div>
        </div>

        <div className={s.brandBody}>
          <h1 className={s.heroTitle}>企业智能体工作台</h1>
          <div className={s.featureList}>
            <div className={s.featureItem}>
              <svg className={s.featureIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <div>
                <div className={s.featureTitle}>隔离沙箱执行</div>
                <div className={s.featureDesc}>每个会话独立工作区，命令与文件不出边界</div>
              </div>
            </div>

            <div className={s.featureItem}>
              <svg className={s.featureIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 12l2 2 4-4" />
                <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
              </svg>
              <div>
                <div className={s.featureTitle}>审批与审核可追溯</div>
                <div className={s.featureDesc}>敏感工具调用需人工确认，交付物经审核员放行</div>
              </div>
            </div>

            <div className={s.featureItem}>
              <svg className={s.featureIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
              </svg>
              <div>
                <div className={s.featureTitle}>按部门配置智能体</div>
                <div className={s.featureDesc}>管理员发布智能体，指定全员或指定员工可用</div>
              </div>
            </div>
          </div>
        </div>

        <div className={s.brandFooter}>UPRC 内部系统 · 仅限授权员工使用</div>
      </aside>

      {/* 右栏登录表单 */}
      <main className={s.formCol}>
        <div className={s.card}>
          <div className={s.cardHeader}>
            <h2 className={s.cardTitle}>登录</h2>
            <p className={s.cardSubtitle}>使用公司账号继续</p>
          </div>

          {/* 退出警告与全局错误 */}
          {logoutWarning ? (
            <div role="status" className={s.warningAlert}>
              {logoutWarning}
            </div>
          ) : null}

          {/* SSO 回调带回的错误 */}
          {ssoError ? (
            <div role="alert" className={s.errorAlert}>
              {ssoError}
            </div>
          ) : null}

          {/* 全局认证错误（如 RequireAuth 重定向到 /login 时的 authError） */}
          {state.authError ? (
            <div role="alert" className={s.errorAlert}>
              <span>{state.authError}</span>
              <button type="button" className={s.linkBtn} onClick={() => void retryAuth()}>重试</button>
            </div>
          ) : null}

          {/* 认证配置加载失败 */}
          {authConfig.error ? (
            <div role="alert" className={s.errorAlert}>
              <span>{authConfig.error}</span>
              <button type="button" className={s.linkBtn} onClick={() => void retryAuth()}>重试</button>
            </div>
          ) : null}

          {/* 正在加载登录方式 */}
          {authConfig.loading ? (
            <div role="status" className={s.loadingState}>
              正在加载登录方式…
            </div>
          ) : null}

          {/* 无可用登录方式 */}
          {!authConfig.loading && caps && noLoginMethodMessage(caps) ? (
            <div role="alert" className={s.warningAlert}>
              {noLoginMethodMessage(caps)}
            </div>
          ) : null}

          {/* 认证能力投影的三种形态 */}
          {!authConfig.loading && caps && !noLoginMethodMessage(caps) && caps.ssoEnabled ? (
            <div className={s.ssoSection}>
              {caps.ssoAvailable ? (
                <button
                  type="button"
                  className={s.ssoPrimaryBtn}
                  onClick={() => { window.location.href = ssoUrl; }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="8" cy="15" r="4" />
                    <path d="M10.8 12.2L20 3" />
                    <path d="M17 6l3 3" />
                    <path d="M15 8l2 2" />
                  </svg>
                  {ssoButtonText(caps.ssoLabel)}
                </button>
              ) : (
                <button
                  type="button"
                  className={s.ssoPrimaryBtn}
                  disabled
                  title="SSO 暂不可用"
                >
                  {caps.ssoLabel} 暂不可用
                </button>
              )}
              <div className={s.ssoHint}>
                {caps.ssoAvailable
                  ? '将跳转到公司统一认证页面'
                  : 'SSO 暂不可用，请使用管理员账号密码登录或联系管理员。'}
              </div>

              {caps.localEnabled ? (
                <>
                  <div className={s.divider}>
                    <span className={s.dividerLine} />
                    <span className={s.dividerText}>或</span>
                    <span className={s.dividerLine} />
                  </div>

                  {!adminFormOpen ? (
                    <button
                      type="button"
                      className={s.adminToggleBtn}
                      onClick={() => setAdminFormOpen(true)}
                    >
                      管理员账号登录
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {/* 本地表单：在仅本地登录模式，或 SSO 展开管理员登录时显示 */}
          {!authConfig.loading && caps && !noLoginMethodMessage(caps) && caps.localEnabled && (!caps.ssoEnabled || adminFormOpen) ? (
            <form className={s.form} onSubmit={handleSubmit}>
              <div className={s.field}>
                <label htmlFor="login-username" className={s.label}>用户名</label>
                <input
                  id="login-username"
                  type="text"
                  name="username"
                  autoComplete="username"
                  placeholder="admin"
                  required
                  disabled={submitting}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={s.input}
                />
              </div>

              <div className={s.field}>
                <label htmlFor="login-password" className={s.label}>密码</label>
                <div className={s.passwordWrapper}>
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    placeholder="请输入密码"
                    required
                    disabled={submitting}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${s.input} ${formError ? s.inputError : ''}`}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    className={s.showPwBtn}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {formError ? (
                  <div role="alert" className={s.fieldError}>
                    {formError}
                  </div>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className={s.submitBtn}
              >
                {submitting ? '正在登录…' : '登录'}
              </button>

              {caps.registrationEnabled ? (
                <button
                  type="button"
                  disabled={submitting}
                  className={s.secondaryBtn}
                  onClick={() => void handleRegister()}
                >
                  注册新账号
                </button>
              ) : null}

              {caps.ssoEnabled ? (
                <div className={s.adminFooter}>
                  <span>本地账号仅对管理员开放</span>
                  <button
                    type="button"
                    className={s.linkBtn}
                    onClick={() => {
                      setAdminFormOpen(false);
                      setFormError(null);
                    }}
                  >
                    收起
                  </button>
                </div>
              ) : null}
            </form>
          ) : null}
        </div>
      </main>
    </div>
  );
}
