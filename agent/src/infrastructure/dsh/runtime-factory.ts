/**
 * DSH 运行时工厂——取代 DshRuntimeFactory。
 *
 * create() 的对外形状与旧引擎工厂兼容（session.prompt / subscribe / abort /
 * getAllTools / dispose），好让 DSH RunExecutor 的锁-围栏-账本路径不变。
 * 内部走 @dsh/runtime：凭据 fail-closed、远程 provider 按 Run 装配，
 * prompt() 驱动 DSH agent.followup + whenIdle。
 * 不加载 @earendil-works/*。
 */

import {
  bootEnterpriseRuntime,
  sharedEnterpriseRuntime,
  createRemoteProviders,
  mountSessionPersistence,
  buildPromptPlan,
  installPromptContract,
  runWithExecRpc,
  runWithRunServices,
  installEnterprisePolicy,
  InMemoryApprovalStore,
  installUserQuestionBridge,
  runWithInteractionRequester,
} from '../../runtime/index.js';
import {
  createFilteredSystemSkillsProvider,
  createPublishedSkillsProvider,
} from './published-skills-provider.js';
import {
  effectiveSystemSkills,
  splitRunSkillPaths,
  ORG_SKILL_LOGICAL_ROOT,
  USER_SKILL_LOGICAL_ROOT,
} from '../../skills/run-skills.js';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { DshRuntimeFactoryError } from './errors.js';
import { waitForPendingTitle } from './session-title-grace.js';
import { PINNED_DSH_VERSION } from './constants.js';
import { bindAgentVersionConfig } from './agent-version-bindings.js';
import { readHostArgumentDeclarations } from '../../domain/agent/mcp-host-arguments.js';
import { readMcpServersFromEnv } from '../../runtime/plugins/mcp-entries.js';
import { dshProviderRoute, reasoningEffortsForRoute } from './reasoning-efforts.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';

/**
 * Skill mounts live in the Agent container, while ctx.fs is the remote
 * workspace filesystem exposed by Exec. Passing the latter to the filesystem
 * skill provider makes `/home/sandbox/skill` look like a workspace path and
 * silently hides every mounted system skill. Keep the provider on the local
 * host filesystem; its roots are fixed, read-only mounts (system plus the
 * already identity-scoped user directory), not arbitrary workspace paths.
 */
function localSkillContext(agentCtx: Context): Context {
  return {
    logger: agentCtx?.logger ?? console,
    get(name: string) {
      if (name === 'fs') return undefined;
      return typeof agentCtx?.get === 'function' ? agentCtx.get(name) : undefined;
    },
  } as Context; // 原因：刻意窄化的门面，只暴露 logger/get 并屏蔽 ctx.fs，FileSystemSkillProvider 仅用这两处
}

export { PINNED_DSH_VERSION } from './constants.js';
export { DshRuntimeFactoryError };

export function buildExecRpcConfig(
  input: Record<string, any>,
  env: NodeJS.ProcessEnv = process.env,
  /** 本 Run 可连的数据源：只来自固定的 AgentVersion（sandbox-data-sources.md §4.1）。 */
  dataSources: readonly string[] = [],
) {
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
  // 本 Run 的清单（ADR 0015 D1 / design §6.3）：随每个 exec 请求进入签名覆盖的
  // 请求体 / query。系统层走 `systemSkills`（`undefined` = 旧 Agent，exec 整树挂载），
  // 按摘要分版本的走 `enabledSkills`，各自带 `scope` 让 exec 选 owner 根。
  const { published: publishedSkills } = splitRunSkillPaths(
    Array.isArray(input.additionalSkillPaths) ? input.additionalSkillPaths : [],
  );
  const enabledSkills = publishedSkills.map((version) => ({
    name: version.name,
    contentDigest: version.contentDigest,
    ...(version.kind === 'org' ? { scope: 'org' as const } : {}),
  }));
  const systemSelection = effectiveSystemSkills(
    Array.isArray(input.additionalSkillPaths) ? input.additionalSkillPaths : [],
  );
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
    // 系统清单**总是**下发（含空数组）：缺省在 exec 那边是兼容期旧 Agent 的整树挂载
    // （design §8）。`names === null` 是裸目录旧形状，生产路径不产出它（只在测试注入里
    // 出现），按空名单处理，见 `effectiveSystemSkills`。
    systemSkills: systemSelection.names === null ? [] : [...systemSelection.names],
    ...(enabledSkills.length > 0 ? { enabledSkills } : {}),
    ...(dataSources.length > 0 ? { dataSources: [...dataSources] } : {}),
    ...(typeof input.fetchImpl === 'function' ? { fetchImpl: input.fetchImpl } : {}),
  };
}

/** 企业目录仍写 llmio；DSH 组合里唯一挂上的路由名是 deepseek-official。 */
/**
 * 供应商路由与「该路由接受哪些 reasoning effort」是同一件事的两面，
 * 所以都放在 `reasoning-efforts.ts`，避免这里再留一份会漂的副本。
 */
function resolveReasoningEffort(providerRoute: string, level: string | null) {
  if (!level) return null;
  const accepted = reasoningEffortsForRoute(providerRoute);
  if (!accepted.includes(level)) {
    // 不猜映射：版本钉的 effort 在当前适配器上不存在时拒绝起 Run，
    // 而不是悄悄降到一个别的档位（AGENTS.md §2 fail-closed）。
    throw new DshRuntimeFactoryError(
      `AgentVersion thinkingLevel "${level}" is not a reasoning effort accepted by ` +
        `provider route "${providerRoute}" (${accepted.join(', ') || 'none'})`,
      { code: 'DSH_THINKING_LEVEL_UNSUPPORTED' },
    );
  }
  return level;
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
  ctx: Context,
  text: unknown,
  options?: { images?: unknown[] },
) {
  // DSH 的图片块保存的是 ctx.attachments 产生的不可变引用，而不是旧引擎
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
        mediaType: mediaType as ImageMediaType, // 原因：附件存储在运行时内校验媒体类型，非法值仍由其拒绝，此处仅补类型
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
 * DSH session/event → 现有 projector 认得的旧引擎事件形状。
 *
 * DSH 的词汇是 `assistant/chunk`、`assistant/message`、`turn/end`。把 `turn/end`
 * 映射成 `message_end` 会给每一轮多造一条空助手气泡；把整份 session log
 * 再 dump 一遍会把上一轮文本拼进本轮。两者叠在一起就是「气泡重复上轮文本
 * 且被 512 字摘要截断」。
 */
export function mapDshEventToAgentEvent(event: Record<string, any> | null | undefined) {
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

  // 旧引擎形状的透传（单测夹具仍发 message_update）。
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
    buildPromptPlan,
    bootEnterpriseRuntime,
    sharedEnterpriseRuntime,
    runWithExecRpc,
    runWithRunServices,
  }));
  const bootRuntime = opts.bootRuntime;
  const createAgent = opts.createAgent;
  // 宿主参数声明：进程级、与 MCP 插件树同一份 MCP_SERVERS_JSON（启动期已校验）。
  const hostArgumentDeclarations =
    opts.hostArgumentDeclarations ??
    readHostArgumentDeclarations(readMcpServersFromEnv(opts.env ?? process.env));

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
      // Bind the immutable version at the factory boundary as well as in the
      // executor. This keeps direct factory callers on the same authorization
      // contract and prevents an unused `toolPolicyBinding` from being the
      // only evidence that a version was considered.
      const boundAgentVersion = input.agentVersion
        ? bindAgentVersionConfig(input.agentVersion)
        : null;
      const rpc = buildExecRpcConfig(input, opts.env ?? process.env, boundAgentVersion?.dataSources ?? []);
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
        password: opts.mysqlPassword,
        onEventsCommitted: opts.onSessionEventsCommitted,
      });
      // AV-06：逻辑路径来自服务端已有的解析入口（container 传进来的
      // workspaceRoot/skillRoot，或本 Run 解析出的 cwd），**不是**写死的默认值，
      // 也**不是** `rpc.physicalRoots`——宿主物理根不进提示词。
      const promptRoots = {
        ...(input.cwd || opts.workspaceRoot
          ? { workspaceRoot: String(input.cwd || opts.workspaceRoot) }
          : {}),
        ...(input.skillRoot || opts.skillRoot
          ? { skillRoot: String(input.skillRoot || opts.skillRoot) }
          : {}),
      };
      const promptPlan = (runtime.buildPromptPlan ?? buildPromptPlan)(
        input.systemPrompt,
        promptRoots,
      );
      void PINNED_DSH_VERSION;

      const sessionId = String(
        input.agentSession?.agentSessionId ?? input.sessionId ?? '',
      );
      const sessionOwner = { orgId: rpc.orgId, userId: rpc.userId };
      const releaseSessionOwner = sessionStore.bindOwner(sessionId, sessionOwner);
      const recoveredPayload = input.sessionSnapshot?.snapshotJson;
      const recoveredHeader = recoveredPayload?.header;
      const recoveredEntries = Array.isArray(recoveredPayload?.entries)
        ? recoveredPayload.entries
        : [];
      const spawn =
        createAgent ??
        ((agentCtx, options) => {
          if (typeof agentCtx?.agents?.create !== 'function') {
            throw new DshRuntimeFactoryError(
              'DSH ctx.agents.create is not mounted; boot @dsh/runtime before create()',
            );
          }
          return agentCtx.agents.create(options);
        });
      const resume =
        opts.resumeAgent ??
        ((agentCtx, options) => {
          if (typeof agentCtx?.agents?.resume !== 'function') {
            throw new DshRuntimeFactoryError(
              'DSH ctx.agents.resume is not mounted; boot @dsh/runtime before resume()',
            );
          }
          return agentCtx.agents.resume(options);
        });
      // AV-05：AgentVersion 的生成参数必须出现在**真实的对话请求**上。
      // `AgentOptions.maxTokens` 的契约就是「每次 conversation-model 请求的
      // 输出上限」，reasoning effort 走 agent scope 的 ModelSelection——
      // 两者都只作用于主对话，标题/压缩等辅助请求仍按各自插件的策略走。
      const providerRoute = dshProviderRoute(input.model.provider);
      const versionMaxTokens = boundAgentVersion?.maxOutputTokens ?? null;
      const versionEffort = resolveReasoningEffort(
        providerRoute,
        boundAgentVersion?.thinkingLevel ?? null,
      );
      const modelSelection = {
        current: {
          provider: providerRoute,
          model: String(input.model.id || input.model.modelId || ''),
          ...(versionEffort ? { reasoningEffort: versionEffort } : {}),
        },
        assembled: undefined,
      };
      const commonAgentOptions = {
        agentOptions: {
          provider: providerRoute,
          model: String(input.model.id || input.model.modelId || ''),
          ...(versionMaxTokens != null ? { maxTokens: versionMaxTokens } : {}),
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
          // 1) 平台路径/行为在 persona 前；工具指导随每一步实际 schema 过滤。
          // 顺序不授予权限，执行授权仍由 enterprise-policy guard 保证。
          // reasoning effort 只能经 agent scope 的 ModelSelection 生效：
          // `AgentOptions` 上没有这个字段，装在根 ctx 上会串到别的 Run。
          if (versionEffort) {
            disposers.push(
              (opts.installModelSelection ?? installModelSelection)(agentCtx, modelSelection),
            );
          }

          disposers.push(await installPromptContract(agentCtx, promptPlan));

          // DSH's default skill filesystem provider does not consume the
          // resourceLoaderOptions passed by this factory. Register this Run's
          // providers in the agent scope: the system tier **filtered by the
          // bound name list** (ADR 0015 D4), plus the ledger-verified published
          // versions (design §3.3 S1), which the published provider exposes at
          // exec's logical mount path.
          const configuredSkillPaths = Array.isArray(input.additionalSkillPaths)
            ? input.additionalSkillPaths
            : opts.additionalSkillPaths;
          const configuredSkills = Array.isArray(configuredSkillPaths) ? configuredSkillPaths : [];
          const { published: publishedSkills } = splitRunSkillPaths(configuredSkills);
          const systemSelection = effectiveSystemSkills(configuredSkills);
          // 只注册**按名过滤**的系统 provider：`names === null` 表示这份清单只有
          // 裸目录字符串（解析不出名字集），design §8 收紧后那种形状既不能整树挂载
          // （`buildExecRpcConfig` 下发空数组），也就不能整树进发现——否则模型在
          // prompt 里看到一堆沙箱里根本不存在的系统包，发现与挂载反着不同构。
          const systemRoot = systemSelection.names === null ? null : systemSelection.root;
          if (systemRoot !== null || publishedSkills.length > 0) {
            const skillCtx = localSkillContext(agentCtx);
            const skillsFiber = agentCtx.inject(['skills'], (scoped) => {
              if (systemRoot !== null && systemSelection.names !== null) {
                const names = systemSelection.names;
                scoped.skills.registerProvider((control) =>
                  createFilteredSystemSkillsProvider(skillCtx, control, {
                    root: systemRoot,
                    names,
                  }),
                );
              }
              for (const kind of ['user', 'org'] as const) {
                const group = publishedSkills.filter((entry) => entry.kind === kind);
                if (group.length === 0) continue;
                scoped.skills.registerProvider((control) =>
                  createPublishedSkillsProvider(skillCtx, control, group, {
                    providerName: kind === 'org' ? 'run-org-published' : 'run-published',
                    logicalRoot: kind === 'org' ? ORG_SKILL_LOGICAL_ROOT : USER_SKILL_LOGICAL_ROOT,
                  }),
                );
              }
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
            // **按 Run 取**：停泊中的 toolCallId 集合绑在 executor 实例上。
            ...(typeof input.isInteractionPending === 'function'
              ? { isInteractionPending: input.isInteractionPending }
              : {}),
            // 运维可配的风险覆盖。以前这份配置解析出来后喂给了一个返回 []
            // 的 extension bundle，等于没配。
            // **按 Run 取**：租户层来自 AgentVersion，工厂是进程级单例。
            // 2026-08-31 之前只读工厂级 opts，而调用方设的是 executor 工厂的
            // 同名字段——两个不同对象，于是整张运维风险表零效果（计划 H8）。
            ...(input.riskOverrides ?? opts.riskOverrides
              ? { riskOverrides: input.riskOverrides ?? opts.riskOverrides }
              : {}),
            ...(input.policyResolver ?? opts.policyResolver
              ? { policyResolver: input.policyResolver ?? opts.policyResolver }
              : {}),
            ...(
              boundAgentVersion?.authorization ?? input.authorization
                ? {
                    authorization:
                      boundAgentVersion?.authorization ?? input.authorization,
                  }
                : {}
            ),
            physicalRoots: rpc.physicalRoots ?? [],
            hostArgumentDeclarations,
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
      const seenEvents: Record<string, any>[] = [];
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
        seenEvents.push(ev);
        for (const fn of subs) fn(ev);
      };
      const emitMapped = (event: Record<string, any>) => {
        const mapped = mapDshEventToAgentEvent(event);
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
          const mapped = mapDshEventToAgentEvent(ev) ?? ev;
          emit(mapped);
        });
      }

      const session = {
        providers,
        sessionStore,
        // 观测用：这一 Run 实际注册的两节提示词（企业条款 + persona 槽位）。
        // persona 原文在 `variables` 里，不在 section 正文里——见 buildPromptPlan。
        promptPlan,
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
            const seenBefore = seenEvents.length;
            agent.followup(await toUserMessage(ctx, text, options));
            if (typeof agent.whenIdle === 'function') await agent.whenIdle();
            const liveLog = agent.session?.events;
            // 直播订阅已经在推事件时不要再 dump 整份 session log——那份 log
            // 含历史轮次，会让本轮气泡重复上轮文本。只在本轮还没有
            // message_end 时补：完全没直播就 dump 本轮新增；只有 delta
            // 没有完成帧时只补 message_end。
            const gotLiveAssistant = seenEvents
              .slice(seenBefore)
              .some((e) => e?.type === 'message_end');
            if (!gotLiveAssistant && Array.isArray(liveLog)) {
              const hadLive = seenEvents.length > seenBefore;
              for (const event of liveLog.slice(priorLen)) {
                if (hadLive && mapDshEventToAgentEvent(event)?.type !== 'message_end') continue;
                emitMapped(event);
              }
            }
            if (turnError) {
              const msg = turnError instanceof Error ? turnError.message : String(turnError);
              throw new DshRuntimeFactoryError(`DSH agent/error: ${msg}`);
            }
            const gotAssistant = seenEvents.slice(seenBefore).some((e) => e?.type === 'message_end')
              || (Array.isArray(liveLog)
                && liveLog.slice(priorLen).some((e) => mapDshEventToAgentEvent(e)?.type === 'message_end'));
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
          // The root registry is process-wide. A Run's restrict/authorization
          // projection lives on the agent scope, so read the same scope DSH
          // uses for guidance and schemas.
          const tools = agent?.ctx?.get?.('tools') ?? (ctx as Record<string, any>)?.get?.('tools');
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
            // 在途的模型标题随会话 dispose 被中止；短回答的 Run 会因此丢标题。
            // 有界等一下（session-title-grace.ts），等不到就放弃。
            await waitForPendingTitle(() => agent?.session?.events).catch(() => undefined);
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
  _inner: ReturnType<typeof createDshRuntimeFactory>;

  constructor(opts = {}) {
    this._inner = createDshRuntimeFactory(opts);
  }
  create(input) {
    return this._inner.create(input);
  }
}
