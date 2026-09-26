/**
 * 宿主参数的 Run 装配（docs/design/mcp-per-agent-arguments.md D3–D5）。
 *
 * 在本 Run 的 agent scope 里给受影响的 MCP 工具注册**同名影子定义**：
 * DSH 的 scope 注册遮蔽 global（出厂 `dsh-tools` 原话 "Scoped registrations shadow
 * globals"），所以模型看到的 schema 与真正执行的定义都是影子，别的 Run 不受影响。
 *
 * - schema：去掉宿主参数（模型看不到）；
 * - 执行：删掉模型给的同名参数，并入本 Agent 的值，再调**调用时**解析到的 global 定义
 *   ——MCP 重连会换掉 global 定义，装配时抓住的引用会过期（spike S4）；
 * - 缺必填值：不注册影子，工具在本 Run 里隐藏并被 guard 拒绝（fail-closed）。
 *   直接执行 global 定义**不校验 required**（spike 附带发现），这一层不能省。
 *
 * 纯装配，不碰账本：审批与账本经 `effectiveArgs` 拿到与执行相同的合并参数。
 */
import {
  hostKeysForSchema,
  hostValueTypeMismatches,
  mergeHostArguments,
  missingRequiredHostArguments,
  stripHostArguments,
  type HostArgumentSpec,
  type HostArgumentValues,
} from '../../domain/agent/mcp-host-arguments.js';
import type { AgentVersionAuthorization } from '../../infrastructure/dsh/agent-version-bindings.js';
import { mcpToolName } from '../../infrastructure/mcp/mcp-config-loader.js';

export const HOST_ARGUMENTS_MISSING_REASON = 'MCP_HOST_ARGUMENTS_MISSING';
export const HOST_ARGUMENTS_UNBOUND_REASON = 'MCP_HOST_ARGUMENTS_UNBOUND';

/** 只取本模块用得到的字段，不复制 DSH 的完整类型。 */
interface ToolDefinitionLike {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly output?: unknown;
  execute(args: Record<string, unknown>, exec: object): Promise<unknown>;
  finalizeContent?(exec: object, result: unknown): unknown;
}

interface ToolRegistryLike {
  /** 不传 scope = global 视图（出厂 `get(name, scope)`）。 */
  get(name: string): ToolDefinitionLike | undefined;
  register(definition: Record<string, unknown>): unknown;
}

export interface HostArgumentBinding {
  /** 本 Run 里因缺必填宿主参数而隐藏的工具 → 缺的键。 */
  readonly hidden: ReadonlyMap<string, readonly string[]>;
  /** 审批、guard、账本看到的参数：与影子实际发出的完全一致。 */
  effectiveArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  /** 非 undefined = 这次调用必须拒绝。 */
  denyReason(toolName: string): string | undefined;
}

type Binding = { keys: readonly string[]; values: HostArgumentValues };

function publicNamesOf(serverId: string, server: AgentVersionAuthorization['mcpServers'][string]): string[] {
  const names = Object.keys(server.publicToolNames ?? {});
  return names.length > 0 ? names : server.enabledTools.map((tool) => mcpToolName(serverId, tool));
}

function disposerOf(registered: unknown): (() => void) | null {
  if (typeof registered === 'function') return registered as () => void;
  const dispose = (registered as { dispose?: unknown } | null)?.dispose;
  return typeof dispose === 'function' ? () => (dispose as () => void).call(registered) : null;
}

/**
 * 为本 Run 注册影子定义。`tools` 必须是本 Run agent scope 的注册表（register 落在
 * scope 层）；`get` 不带 scope 读 global。返回的 disposers 由调用方随 Run 释放。
 */
export function bindHostArguments(
  tools: ToolRegistryLike,
  options: {
    authorization: AgentVersionAuthorization;
    declarations: ReadonlyMap<string, HostArgumentSpec>;
    log?: (line: string) => void;
  },
): { binding: HostArgumentBinding; disposers: Array<() => void> } {
  const bound = new Map<string, Binding>();
  const hidden = new Map<string, readonly string[]>();
  const declaredServers = new Set<string>();
  const disposers: Array<() => void> = [];
  const log = options.log ?? ((line: string) => console.warn(line));

  for (const [serverId, server] of Object.entries(options.authorization.mcpServers)) {
    const spec = options.declarations.get(serverId);
    if (spec === undefined) continue;
    declaredServers.add(serverId);
    const values = server.toolArguments ?? {};
    const unknownKeys = Object.keys(values).filter((key) => !Object.hasOwn(spec, key));
    if (unknownKeys.length > 0) {
      // 保存期已挡；这里是登记表在保存后被运维改掉的情形。多余的值不发出去。
      log(`[mcp-host-args] ignoring undeclared keys server=${serverId} keys=${unknownKeys.join(',')}`);
    }
    for (const name of publicNamesOf(serverId, server)) {
      const original = tools.get(name);
      if (original === undefined) continue; // 未连上：guard 在调用时按 global schema 兜底
      const keys = hostKeysForSchema(original.parameters, spec);
      if (keys.length === 0) continue;
      const missing = missingRequiredHostArguments(original.parameters, keys, values);
      if (missing.length > 0) {
        hidden.set(name, missing);
        log(`[mcp-host-args] hidden tool=${name} missing=${missing.join(',')}`);
        continue;
      }
      const binding: Binding = { keys, values };
      bound.set(name, binding);
      const executedBy = new WeakMap<object, ToolDefinitionLike>();
      const registered = tools.register({
        name,
        description: original.description ?? '',
        parameters: stripHostArguments(original.parameters, keys),
        output: original.output,
        async execute(modelArgs: Record<string, unknown>, exec: object) {
          const current = tools.get(name);
          if (current === undefined || current.execute === undefined) {
            throw new Error(`MCP_TOOL_UNAVAILABLE: ${name} is not connected`);
          }
          const mismatched = hostValueTypeMismatches(current.parameters, keys, values);
          if (mismatched.length > 0) {
            throw new Error(`MCP_ARGUMENT_TYPE_MISMATCH: ${mismatched.join(', ')} does not match the tool schema`);
          }
          executedBy.set(exec, current);
          return current.execute(mergeHostArguments(modelArgs ?? {}, keys, values), exec);
        },
        // 出厂 MCP 定义按 exec 暂存富内容投影；必须交回**执行它的那一代**定义。
        finalizeContent(exec: object, result: unknown) {
          const current = executedBy.get(exec);
          executedBy.delete(exec);
          return current?.finalizeContent?.(exec, result);
        },
      });
      const dispose = disposerOf(registered);
      if (dispose) disposers.push(dispose);
    }
  }

  const binding: HostArgumentBinding = {
    hidden,
    effectiveArgs(toolName, args) {
      const entry = bound.get(toolName);
      return entry === undefined ? args : mergeHostArguments(args, entry.keys, entry.values);
    },
    denyReason(toolName) {
      if (hidden.has(toolName)) {
        return `${HOST_ARGUMENTS_MISSING_REASON}: ${toolName} needs ${hidden.get(toolName)!.join(', ')} configured on this agent`;
      }
      if (bound.has(toolName) || !toolName.startsWith('mcp__')) return undefined;
      // 装配时没连上、之后才出现的工具：没有影子，模型会直接调到 global 定义。
      // 若它带宿主参数，放行就等于让模型自己填——拒绝。
      const serverId = options.authorization.mcpTools?.[toolName]?.serverId;
      if (serverId === undefined || !declaredServers.has(serverId)) return undefined;
      const current = tools.get(toolName);
      const spec = options.declarations.get(serverId) ?? {};
      if (current !== undefined && hostKeysForSchema(current.parameters, spec).length > 0) {
        return `${HOST_ARGUMENTS_UNBOUND_REASON}: ${toolName} became available after this run started`;
      }
      return undefined;
    },
  };
  return { binding, disposers };
}
