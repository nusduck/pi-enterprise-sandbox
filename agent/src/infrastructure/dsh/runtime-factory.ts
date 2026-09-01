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
  sharedEnterpriseRuntime,
  createRemoteProviders,
  mountSessionPersistence,
  assembleSystemPrompt,
  runWithExecRpc,
  runWithRunServices,
  installEnterprisePolicy,
  InMemoryApprovalStore,
  installUserQuestionBridge,
  runWithInteractionRequester,
} from '../../runtime/index.js';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { DshRuntimeFactoryError } from './errors.js';
import { PINNED_DSH_VERSION } from './constants.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/**
 * Skill mounts live in the Agent container, while ctx.fs is the remote
 * workspace filesystem exposed by Exec. Passing the latter to the filesystem
 * skill provider makes `/home/sandbox/skill` look like a workspace path and
 * silently hides every mounted system skill. Keep the provider on the local
 * host filesystem; its roots are fixed, read-only mounts (system plus the
 * already identity-scoped user directory), not arbitrary workspace paths.
 */
function localSkillContext(agentCtx: Loose): Loose {
  return {
    logger: agentCtx?.logger ?? console,
    get(name: string) {
      if (name === 'fs') return undefined;
      return typeof agentCtx?.get === 'function' ? agentCtx.get(name) : undefined;
    },
  };
}

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
  const runId = String(ctx.runId ?? input.runId ?? '').trim();
  const sandboxSessionId = String(
    ctx.sandboxSessionId ?? session.sandboxSessionId ?? '',
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
    ...(runId ? { runId } : {}),
    ...(sandboxSessionId ? { sandboxSessionId } : {}),
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

/** Null root on an empty journal; otherwise the last prior entry id. */
export function parentIdForAppend(
  prior: Array<{ id?: unknown }> | null | undefined,
): string | null {
  if (!Array.isArray(prior) || prior.length === 0) return null;
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const id = prior[i]?.id;
    if (typeof id === 'string' && id.trim()) return id;
  }
  return null;
}

async function toUserMessage(
  ctx: Loose,
  text: unknown,
  options?: { images?: unknown[] },
) {
  // DSH 的图片块保存的是 ctx.attachments 产生的不可变引用，而不是旧 Pi
  // API 的 { data, mimeType } 临时块。图片 loader 在进入 DSH 前仍可用旧形状
  // 搬运并校验字节；这里是唯一的边界适配，避免 base64 落进会话日志。
  const content: Array<{ type: string; [key: string]: unknown }> = [
    { type: 'text', text: String(text ?? '') },
  ];
  const images = options?.images;
  if (Array.isArray(images)) {
    for (const image of images) {
      if (!image || typeof image !== 'object') continue;
      const value = image as Record<string, unknown>;
      if (value.type !== 'image') {
        content.push(value as { type: string; [key: string]: unknown });
        continue;
      }
      if (value.attachment && typeof value.attachment === 'object') {
        content.push(value as { type: string; [key: string]: unknown });
        continue;
      }
      const data = typeof value.data === 'string' ? value.data : '';
      const mediaType = String(value.mimeType ?? value.mediaType ?? '').trim().toLowerCase();
      const attachments = ctx?.get?.('attachments');
      if (!data || !mediaType || typeof attachments?.saveImage !== 'function') {
        throw new DshRuntimeFactoryError(
          'DSH image prompt requires attachment bytes and a mounted attachment store',
        );
      }
      const attachment = await attachments.saveImage({
        data: Buffer.from(data, 'base64'),
        mediaType,
        ...(typeof value.name === 'string' && value.name.trim()
          ? { name: value.name.trim() }
          : {}),
      });
      content.push({ type: 'image', attachment });
    }
  }
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `user-${Date.now()}`;
  return { id, role: 'user', content, source: { kind: 'user' } };
}

/**
 * DSH session/event → 现有 projector 认得的 Pi 形状。
 *
 * DSH 的词汇是 `assistant/chunk`、`assistant/message`、`turn/end`。把 `turn/end`
 * 映射成 `message_end` 会给每一轮多造一条空助手气泡；把整份 session log
 * 再 dump 一遍会把上一轮文本拼进本轮。两者叠在一起就是「气泡重复上轮文本
 * 且被 512 字摘要截断」。
 */
export function mapDshEventToPi(event: Record<string, any> | null | undefined) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type ?? '');
  const data = event.data && typeof event.data === 'object' ? event.data : event;

  if (type === 'assistant/chunk') {
    const chunk = data.chunk && typeof data.chunk === 'object' ? data.chunk : data;
    const chunkType = String(chunk.type ?? '');
    if (chunkType === 'text-delta') {
      return {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: String(chunk.text ?? '') },
      };
    }
    if (chunkType === 'reasoning-delta') {
      return {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: String(chunk.text ?? '') },
      };
    }
    return null;
  }

  if (type === 'assistant/message' || type === 'message_end' || type === 'assistant/end') {
    const message = data.message ?? data;
    return {
      type: 'message_end',
      message: {
        role: message?.role ?? 'assistant',
        content: message?.content ?? [{ type: 'text', text: String(message?.text ?? '') }],
        stopReason: message?.stopReason ?? (message?.interrupted ? 'interrupted' : 'stop'),
      },
    };
  }

  // 旧 Pi 形状的透传（单测夹具仍发 message_update）。
  if (type === 'message_update' || type.startsWith('message_')) {
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
    mountSessionPersistence,
    assembleSystemPrompt,
    bootEnterpriseRuntime,
    sharedEnterpriseRuntime,
    runWithExecRpc,
    runWithRunServices,
  }));
  const bootRuntime = opts.bootRuntime;
  const createAgent = opts.createAgent;

  async function ensureCtx(runtime) {
    const ctx = typeof bootRuntime === 'function'
      ? await bootRuntime()
      : await (runtime.sharedEnterpriseRuntime ?? sharedEnterpriseRuntime)();
    // `userQuestions` is a process-level service; the provider itself resolves
    // the active Run from ALS when a tool asks a question.
    installUserQuestionBridge(ctx);
    return ctx;
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
      const sessionStore = runtime.mountSessionPersistence(ctx, {
        physicalRoots: rpc.physicalRoots,
        requireMysql: true,
      });
      const promptText = runtime.assembleSystemPrompt(input.systemPrompt);
      void PINNED_DSH_VERSION;

      const sessionId = String(
        input.agentSession?.agentSessionId ?? input.sessionId ?? '',
      );
      const sessionOwner = { orgId: rpc.orgId, userId: rpc.userId };
      const releaseSessionOwner = sessionStore.bindOwner(sessionId, sessionOwner);
      const recoveredPayload = input.piSnapshot?.snapshotJson;
      const recoveredHeader = recoveredPayload?.header;
      const recoveredEntries = Array.isArray(recoveredPayload?.entries)
        ? recoveredPayload.entries
        : [];
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
      const resume =
        opts.resumeAgent ??
        ((agentCtx, options) => {
          if (typeof agentCtx?.agents?.resume !== 'function') {
            throw new DshRuntimeFactoryError(
              'DSH ctx.agents.resume is not mounted; boot @pi/runtime before resume()',
            );
          }
          return agentCtx.agents.resume(options);
        });
      const commonAgentOptions = {
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
        async setup(agentCtx) {
          // 1) 企业系统提示词。order -50：在 harness 身份(-100)之后、
          //    部署 persona(0) 之前——企业条款约束 persona，不该被它盖掉。
          //
          //    服务名是 `systemPrompt`（驼峰），且**必须经 inject 取**：
          //    直接 `agentCtx.systemPrompt` 会抛 "cannot get property without
          //    inject"。这两点都是实跑探针撞出来的，不是文档里写着的。
          const systemPromptFiber = agentCtx.inject(['systemPrompt'], (scoped) => {
            scoped.systemPrompt.section({
              name: 'enterprise-contract',
              order: -50,
              text: promptText,
            });
          });
          disposers.push(systemPromptFiber);
          await systemPromptFiber;

          // DSH's default skill filesystem provider does not consume the
          // resourceLoaderOptions passed by this factory. Register one in the
          // agent scope so only this Run's system and user roots are visible.
          const configuredSkillPaths = Array.isArray(input.additionalSkillPaths)
            ? input.additionalSkillPaths
            : opts.additionalSkillPaths;
          const skillPaths = Array.isArray(configuredSkillPaths)
            ? configuredSkillPaths.filter((path) => typeof path === 'string' && path.trim())
            : [];
          if (skillPaths.length > 0) {
            const skillCtx = localSkillContext(agentCtx);
            const skillsFiber = agentCtx.inject(['skills'], (scoped) => {
              scoped.skills.registerProvider((control) =>
                new FileSystemSkillProvider(skillCtx, control, {
                  providerName: 'run-filesystem',
                  includeDefaultRoots: false,
                  customSkillDirs: skillPaths,
                  dshHome: '/home/sandbox',
                  agentsHome: '/home/sandbox',
                  watch: false,
                }),
              );
            });
            disposers.push(skillsFiber);
            await skillsFiber;
          }

          // 2) 四个策略挂载点。审批 store 目前是进程内的；换成 MySQL 只换这一个
          //    实参（`InstallPolicyOptions.approvalStore`）。
          const installed = installEnterprisePolicy(agentCtx, {
            // **按 Run 取**：审批 store 绑着这一个 Run 的 fence / runId / scope，
            // 工厂是进程级单例，把它放在 opts 上会让 A 的审批记到 B 的 Run 上。
            // 兜底的 InMemoryApprovalStore 只在没接 durable 面时用（单测）。
            approvalStore:
              input.approvalStore ?? opts.approvalStore ?? new InMemoryApprovalStore(),
            ...(opts.policyGuards ? { guards: opts.policyGuards } : {}),
            ...(opts.ledger ? { ledger: opts.ledger } : {}),
            // **按 Run 取**：记录器绑着这个 Run 的 fence/runId/scope。
            ...(input.toolLedger ? { toolLedger: input.toolLedger } : {}),
            // 运维可配的风险覆盖。以前这份配置解析出来后喂给了一个返回 []
            // 的 extension bundle，等于没配。
            // **按 Run 取**：租户层来自 AgentVersion，工厂是进程级单例。
            // 2026-08-31 之前只读工厂级 opts，而调用方设的是 executor 工厂的
            // 同名字段——两个不同对象，于是整张运维风险表零效果（计划 H8）。
            ...(input.riskOverrides ?? opts.riskOverrides
              ? { riskOverrides: input.riskOverrides ?? opts.riskOverrides }
              : {}),
            physicalRoots: rpc.physicalRoots ?? [],
            env: opts.env ?? process.env,
          });
          disposers.push(() => installed.dispose());
          // persistence 在 create/resume 之前已经挂在根 ctx 上；这里只组装本 Run 的
          // 提示词和策略。DSH 发布前会自己 flush 到 ctx.sessionPersistence。
        },
      };
      let handle;
      try {
        const persisted = await sessionStore.runAsOwner(
          sessionOwner,
          () => sessionStore.has(sessionId),
        );
        console.info(JSON.stringify({
          msg: persisted ? 'dsh session resume' : 'dsh session create',
          sessionId,
        }));
        handle = await sessionStore.runAsOwner(
          sessionOwner,
          () => persisted
            ? resume(ctx, { ...commonAgentOptions, resumeSessionId: sessionId })
            : spawn(ctx, {
                ...commonAgentOptions,
                sessionId,
                meta: { cwd: input.cwd },
              }),
        );
      } catch (error) {
        releaseSessionOwner();
        throw error;
      }
      const agent = handle?.agent ?? handle;
      if (!agent || typeof agent.followup !== 'function') {
        throw new DshRuntimeFactoryError('createAgent must return an agent with followup()');
      }

      const subs: Array<(ev: Record<string, any>) => void> = [];
      const entries = [];
      const seenEntryIds = new Set<string>();
      const seenPi: Record<string, any>[] = [];
      const recordAssistantEntry = (event: Record<string, any>, mapped: Record<string, any>) => {
        if (mapped?.type !== 'message_end') return;
        const data = event.data && typeof event.data === 'object' ? event.data : event;
        const turn = data.turn;
        const step = data.step;
        const id =
          Number.isFinite(Number(turn)) && Number.isFinite(Number(step))
            ? `dsh:assistant:${turn}:${step}`
            : `dsh:assistant:${seenEntryIds.size + 1}`;
        if (seenEntryIds.has(id)) return;
        seenEntryIds.add(id);
        entries.push({
          type: 'message',
          id,
          parentId: parentIdForAppend([...recoveredEntries, ...entries]),
          timestamp: new Date().toISOString(),
          message: mapped.message,
        });
      };
      const emit = (ev) => {
        seenPi.push(ev);
        for (const fn of subs) fn(ev);
      };
      const emitMapped = (event: Record<string, any>) => {
        const mapped = mapDshEventToPi(event);
        if (!mapped) return false;
        recordAssistantEntry(event, mapped);
        emit(mapped);
        return true;
      };
      let turnError: unknown = null;
      const onAgentError = (payload) => {
        const err = payload?.error ?? payload;
        if (err) turnError = err;
      };
      if (typeof agent.ctx?.on === 'function') {
        agent.ctx.on('session/event', (sess, event) => {
          if (sess != null && agent.id != null && sess.id !== agent.id) return;
          emitMapped(event);
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
          // 两层 ALS 都必须罩住整轮（ADR 0009 D3 的硬约束）：
          //   exec-rpc  —— ctx.fs/shell/jobs 的租户与脱敏根
          //   run-services —— 子 Agent 的 durable 队列/结果存储（计划 H5）
          // 它们服务的都是「注册在进程级、却必须按 Run 干活」的插件。
          const withServices = runtime.runWithRunServices ?? ((_: unknown, fn: () => unknown) => fn());
          return sessionStore.runAsOwner(sessionOwner, () => run(rpc, async () => withServices(input.runServices ?? {}, async () => runWithInteractionRequester(input.interactionRequester, async () => {
            const log = agent.session?.events;
            const priorLen = Array.isArray(log) ? log.length : 0;
            const seenBefore = seenPi.length;
            agent.followup(await toUserMessage(ctx, text, options));
            if (typeof agent.whenIdle === 'function') await agent.whenIdle();
            const liveLog = agent.session?.events;
            // 直播订阅已经在推事件时不要再 dump 整份 session log——那份 log
            // 含历史轮次，会让本轮气泡重复上轮文本。只在本轮还没有
            // message_end 时补：完全没直播就 dump 本轮新增；只有 delta
            // 没有完成帧时只补 message_end。
            const gotLiveAssistant = seenPi
              .slice(seenBefore)
              .some((e) => e?.type === 'message_end');
            if (!gotLiveAssistant && Array.isArray(liveLog)) {
              const hadLive = seenPi.length > seenBefore;
              for (const event of liveLog.slice(priorLen)) {
                if (hadLive && mapDshEventToPi(event)?.type !== 'message_end') continue;
                emitMapped(event);
              }
            }
            if (turnError) {
              const msg = turnError instanceof Error ? turnError.message : String(turnError);
              throw new DshRuntimeFactoryError(`DSH agent/error: ${msg}`);
            }
            const gotAssistant = seenPi.slice(seenBefore).some((e) => e?.type === 'message_end')
              || (Array.isArray(liveLog)
                && liveLog.slice(priorLen).some((e) => mapDshEventToPi(e)?.type === 'message_end'));
            if (!gotAssistant) {
              throw new DshRuntimeFactoryError(
                `DSH turn produced no assistant output; events=${summarizeSessionLog(liveLog)}`,
              );
            }
            return { entries: [...entries] };
          }))));
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
          agent.steer(await toUserMessage(ctx, text));
        },
        /**
         * 模型可见的工具面。
         *
         * 2026-08-31（ADR 0009 D11 / 计划 H8.6）之前这里返回的是
         * `[providers.fs, providers.shell, providers.jobs]`——那是三个**能力
         * provider**，不是工具：模型看不见它们，它们也没有工具名。
         * 拿它当工具清单，任何基于它的诊断/投影都是错的。
         *
         * 真正的清单在 DSH 的注册表里，按 scope 投影（`ctx.tools.schemas()`）。
         */
        getAllTools() {
          const tools = (ctx as Record<string, any>)?.get?.('tools');
          if (tools === undefined || typeof tools.schemas !== 'function') return [];
          return tools.schemas().map((schema: { name?: unknown }) => ({
            name: String(schema?.name ?? ''),
          }));
        },
      };
      return {
        session,
        sessionManager: {
          getHeader: () => recoveredHeader
            ? structuredClone(recoveredHeader)
            : {
                type: 'session',
                version: 3,
                id: sessionId,
                timestamp: new Date().toISOString(),
                cwd: input.cwd,
              },
          getEntries: () => [...structuredClone(recoveredEntries), ...entries],
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
          try {
            if (typeof handle?.dispose === 'function') {
              await sessionStore.runAsOwner(sessionOwner, () => handle.dispose());
            }
          } finally {
            releaseSessionOwner();
          }
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
