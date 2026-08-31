/**
 * DSH 运行时工厂——取代 PiRuntimeFactory。
 *
 * create() 的对外形状与旧 Pi 工厂兼容（session.prompt / subscribe / abort /
 * getAllTools / dispose），好让 Dsh/Pi RunExecutor 的锁-围栏-账本路径不变。
 * 内部走 @pi/runtime：凭据 fail-closed、远程 provider 按 Run 装配，
 * prompt() 驱动 DSH agent.followup + whenIdle。
 * 不加载 @earendil-works/*。
 */

import {
  bootEnterpriseRuntime,
  createRemoteProviders,
  createSessionBackend,
  assembleSystemPrompt,
  runWithExecRpc,
  installEnterprisePolicy,
  InMemoryApprovalStore,
} from '../../runtime/index.js';
import { DshRuntimeFactoryError } from './errors.js';
import { PINNED_DSH_VERSION } from './constants.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export { PINNED_DSH_VERSION, PINNED_PI_SDK_VERSION } from './constants.js';
export { DshRuntimeFactoryError };

export function buildExecRpcConfig(input: Record<string, any>, env: NodeJS.ProcessEnv = process.env) {
  const ctx = input?.context && typeof input.context === 'object' ? input.context : {};
  const session = input?.agentSession && typeof input.agentSession === 'object'
    ? input.agentSession
    : {};
  const orgId = String(ctx.orgId ?? session.orgId ?? '').trim();
  const userId = String(ctx.userId ?? session.userId ?? '').trim();
  const workspaceId = String(
    ctx.workspaceId ?? session.workspaceId ?? input?.cwd ?? '',
  ).trim();
  if (!orgId || !userId || !workspaceId) {
    throw new DshRuntimeFactoryError(
      'runtime factory requires orgId, userId, and workspaceId for exec RPC',
    );
  }
  const keyring = String(env.SANDBOX_INTERNAL_HMAC_KEYRING || '').trim();
  const activeKid = String(env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID || '').trim();
  if (!keyring || !activeKid) {
    throw new DshRuntimeFactoryError(
      'SANDBOX_INTERNAL_HMAC_KEYRING and SANDBOX_INTERNAL_HMAC_ACTIVE_KID are required',
    );
  }
  const physicalRoots = Array.isArray(input.physicalRoots)
    ? input.physicalRoots.map(String)
    : [String(input.cwd)];
  return {
    baseUrl: String(env.SANDBOX_BASE_URL || 'http://sandbox:8081').replace(/\/+$/, ''),
    keyring,
    activeKid,
    orgId,
    userId,
    workspaceId,
    fenceToken: Number(ctx.executionFenceToken ?? ctx.fenceToken ?? 0) || 0,
    physicalRoots,
    ...(typeof input.fetchImpl === 'function' ? { fetchImpl: input.fetchImpl } : {}),
  };
}

/** 企业目录仍写 llmio；DSH 组合里唯一挂上的路由名是 deepseek-official。 */
function dshProviderRoute(raw) {
  const p = String(raw ?? '').trim();
  if (!p || p === 'llmio' || p === 'openai' || p === 'deepseek') return 'deepseek-official';
  return p;
}

function toUserMessage(
  text: unknown,
  options?: { images?: unknown[] },
) {
  // 首块是文本，后面可以追加图片块——两者形状不同，所以元素类型只约束
  // 共有的 `type`，其余字段由各块自己带。
  const content: Array<{ type: string; [key: string]: unknown }> = [
    { type: 'text', text: String(text ?? '') },
  ];
  const images = options?.images;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (image && typeof image === 'object')
        content.push(image as { type: string; [key: string]: unknown });
    }
  }
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `user-${Date.now()}`;
  return { id, role: 'user', content, source: { kind: 'user' } };
}

function mapDshEventToPi(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  const data = event.data && typeof event.data === 'object' ? event.data : event;
  if (
    type === 'message_end' ||
    type === 'assistant/end' ||
    type === 'assistant/message' ||
    type === 'turn/end'
  ) {
    const message = data.message ?? data;
    return {
      type: 'message_end',
      message: {
        role: message?.role ?? 'assistant',
        content: message?.content ?? [{ type: 'text', text: String(message?.text ?? '') }],
        stopReason: message?.stopReason ?? 'stop',
      },
    };
  }
  if (type.startsWith('message') || type.startsWith('assistant')) {
    return event;
  }
  return null;
}

function eventTypeOf(event) {
  return event && typeof event === 'object' ? String(event.type ?? '') : '';
}

function summarizeSessionLog(log) {
  const types = (Array.isArray(log) ? log : [])
    .map((e) => eventTypeOf(e))
    .filter(Boolean)
    .slice(-8);
  return types.length > 0 ? types.join(',') : '(empty)';
}

export function createDshRuntimeFactory(opts: Record<string, any> = {}) {
  const loadRuntime = opts.loadRuntime ?? (async () => ({
    createRemoteProviders,
    createSessionBackend,
    assembleSystemPrompt,
    bootEnterpriseRuntime,
    runWithExecRpc,
  }));
  const bootRuntime = opts.bootRuntime;
  const createAgent = opts.createAgent;

  let bootOnce: Promise<Record<string, any>> | null = null;

  async function ensureCtx(runtime) {
    if (typeof bootRuntime === 'function') return bootRuntime();
    if (bootOnce == null) {
      const boot = runtime.bootEnterpriseRuntime ?? bootEnterpriseRuntime;
      bootOnce = Promise.resolve(boot());
    }
    return bootOnce;
  }

  return {
    async create(input: Record<string, any>) {
      if (!input?.model) {
        throw new DshRuntimeFactoryError('runtime factory requires model');
      }
      if (!input?.cwd) {
        throw new DshRuntimeFactoryError('runtime factory requires cwd');
      }
      const runtime = await loadRuntime();
      const rpc = buildExecRpcConfig(input, opts.env ?? process.env);
      /** per-Run 装配的卸载器。Run 结束时必须逐个调用——监听器与 guard 都是有主的。
       * @type {Array<() => void>} */
      const disposers = [];
      const ctx = await ensureCtx(runtime);
      // provider 是**全进程共享的单例**（`ensureCtx` 是 bootOnce），所以这里
      // **不得**按 Run 改写它——ADR 0009 D3 原文：「并发 Run 不得靠 rebind 根 ctx 上
      // 的同一份 provider，那会串台」。2026-08-31 之前这里有一段 `p.rebind(rpc)`，
      // 正是被禁止的写法：并发的第二个 Run 会把第一个 Run 的脱敏根换掉，
      // A 的未分类错误按 B 的根脱敏 = A 的真实物理路径原样泄漏。
      //
      // 本 Run 的租户/围栏只经 `runWithExecRpc` 的 ALS 传递：`ExecRpcClient` 的
      // envelope 与 physicalRoots 都在**调用时**取 `currentExecRpc()`。
      // 因此 prompt() 里的 ALS 作用域必须罩住所有工具执行（同 D3）。
      const providers = runtime.createRemoteProviders(ctx, rpc);
      const sessionStore = runtime.createSessionBackend({
        physicalRoots: rpc.physicalRoots,
      });
      const promptText = runtime.assembleSystemPrompt(input.systemPrompt);
      void PINNED_DSH_VERSION;

      const sessionId = String(
        input.agentSession?.agentSessionId ?? input.sessionId ?? '',
      );
      const spawn =
        createAgent ??
        ((agentCtx, options) => {
          if (typeof agentCtx?.agents?.create !== 'function') {
            throw new DshRuntimeFactoryError(
              'DSH ctx.agents.create is not mounted; boot @pi/runtime before create()',
            );
          }
          return agentCtx.agents.create(options);
        });
      const handle = await spawn(ctx, {
        sessionId,
        meta: { cwd: input.cwd },
        agentOptions: {
          provider: dshProviderRoute(input.model.provider),
          model: String(input.model.id || input.model.modelId || ''),
        },
        /**
         * per-Run 装配。`setup` 拿到的是**未发布的 agent scope**——正是
         * ADR 0007 D7 说的"每个 Run 一个 scope，承载该 Run 的工具视图、guard
         * 与 skill 层"。企业策略必须装在这里而不是根 ctx 上：装根上会让所有
         * Run 共用一份预算与 guard。
         *
         * 2026-08-30 之前这里是 `void promptText; void sessionStore;`——
         * 系统提示词与 MySQL 会话后端算出来就丢了，四个策略挂载点一个没接。
         * Wave 5 的 policy/ 全套有单测且全绿，因为那些测的是纯函数。
         */
        setup(agentCtx) {
          // 1) 企业系统提示词。order -50：在 harness 身份(-100)之后、
          //    部署 persona(0) 之前——企业条款约束 persona，不该被它盖掉。
          //
          //    服务名是 `systemPrompt`（驼峰），且**必须经 inject 取**：
          //    直接 `agentCtx.systemPrompt` 会抛 "cannot get property without
          //    inject"。这两点都是实跑探针撞出来的，不是文档里写着的。
          disposers.push(
            agentCtx.inject(['systemPrompt'], (scoped) => {
              scoped.systemPrompt.section({
                name: 'enterprise-contract',
                order: -50,
                text: promptText,
              });
            }),
          );

          // 2) 四个策略挂载点。审批 store 目前是进程内的；换成 MySQL 只换这一个
          //    实参（`InstallPolicyOptions.approvalStore`）。
          const installed = installEnterprisePolicy(agentCtx, {
            approvalStore: opts.approvalStore ?? new InMemoryApprovalStore(),
            ...(opts.policyGuards ? { guards: opts.policyGuards } : {}),
            ...(opts.ledger ? { ledger: opts.ledger } : {}),
            // 运维可配的风险覆盖。以前这份配置解析出来后喂给了一个返回 []
            // 的 extension bundle，等于没配。
            ...(opts.riskOverrides ? { riskOverrides: opts.riskOverrides } : {}),
            physicalRoots: rpc.physicalRoots ?? [],
            env: opts.env ?? process.env,
          });
          disposers.push(() => installed.dispose());

          return {
            commit() {
              // 会话持久化后端必须在发布前就位，否则第一轮的事件没有落点。
              void sessionStore;
            },
          };
        },
      });
      const agent = handle?.agent ?? handle;
      if (!agent || typeof agent.followup !== 'function') {
        throw new DshRuntimeFactoryError('createAgent must return an agent with followup()');
      }

      const subs: Array<(ev: Record<string, any>) => void> = [];
      const entries = [];
      const seenPi: Record<string, any>[] = [];
      const emit = (ev) => {
        seenPi.push(ev);
        for (const fn of subs) fn(ev);
      };
      let turnError: unknown = null;
      const onAgentError = (payload) => {
        const err = payload?.error ?? payload;
        if (err) turnError = err;
      };
      if (typeof agent.ctx?.on === 'function') {
        agent.ctx.on('session/event', (sess, event) => {
          if (sess != null && agent.id != null && sess.id !== agent.id) return;
          const mapped = mapDshEventToPi(event);
          if (mapped) emit(mapped);
        });
        agent.ctx.on('agent/error', onAgentError);
      } else if (typeof agent.subscribe === 'function') {
        agent.subscribe((ev) => {
          const mapped = mapDshEventToPi(ev) ?? ev;
          emit(mapped);
        });
      }

      const session = {
        providers,
        sessionStore,
        promptText,
        async prompt(text, options) {
          const run = runtime.runWithExecRpc ?? ((_, fn) => fn());
          return run(rpc, async () => {
            agent.followup(toUserMessage(text, options));
            if (typeof agent.whenIdle === 'function') await agent.whenIdle();
            const log = agent.session?.events;
            if (Array.isArray(log)) {
              for (const event of log) {
                const mapped = mapDshEventToPi(event);
                if (mapped) emit(mapped);
              }
            }
            if (turnError) {
              const msg = turnError instanceof Error ? turnError.message : String(turnError);
              throw new DshRuntimeFactoryError(`DSH agent/error: ${msg}`);
            }
            const gotAssistant = seenPi.some((e) => e?.type === 'message_end')
              || (Array.isArray(log) && log.some((e) => mapDshEventToPi(e)?.type === 'message_end'));
            if (!gotAssistant) {
              throw new DshRuntimeFactoryError(
                `DSH turn produced no assistant output; events=${summarizeSessionLog(log)}`,
              );
            }
            return { entries: [...entries] };
          });
        },
        subscribe(fn) {
          subs.push(fn);
          return () => {
            const i = subs.indexOf(fn);
            if (i >= 0) subs.splice(i, 1);
          };
        },
        abort() {
          if (typeof agent.cancel === 'function') agent.cancel('abort');
        },
        async steer(text) {
          if (typeof agent.steer !== 'function') {
            throw new Error('DSH agent.steer() is unavailable');
          }
          agent.steer(toUserMessage(text));
        },
        getAllTools() {
          return [providers.fs, providers.shell, providers.jobs].filter(Boolean);
        },
      };
      return {
        session,
        sessionManager: {
          getHeader: () => ({
            type: 'session',
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd: input.cwd,
          }),
          getEntries: () => [...entries],
          getCwd: () => input.cwd,
          getSessionId: () => sessionId,
        },
        async dispose() {
          // 先卸 per-Run 装配再销毁 agent：监听器与 guard 都是有主的，
          // 靠 GC 回收会让下一个 Run 继承上一个 Run 的预算与 guard。
          for (const off of disposers.reverse()) {
            try {
              off();
            } catch {
              // 卸载失败不该盖过调用方正在处理的错误。
            }
          }
          if (typeof handle?.dispose === 'function') await handle.dispose();
          if (typeof sessionStore?.close === 'function') await sessionStore.close();
        },
      };
    },
  };
}

export class DshRuntimeFactory {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  _inner: Loose;

  constructor(opts = {}) {
    this._inner = createDshRuntimeFactory(opts);
  }
  create(input) {
    return this._inner.create(input);
  }
}
