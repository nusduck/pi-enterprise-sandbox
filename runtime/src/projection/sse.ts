/**
 * 平台事件 → BFF/前端 SSE。契约夹具 `tests/fixtures/sse_events.json` 逐字节不变。
 *
 * api-server / frontend 零改动的依据就是这些事件形状。这里只投影，不发明新字段。
 */

export interface SseEvent extends Record<string, unknown> {
  readonly type: string;
}

export function encodeSseData(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function encodeSseStream(events: readonly SseEvent[]): string {
  return events.map(encodeSseData).join('');
}

/** 把内部生命周期映射成夹具里的产品事件。未识别的类型丢弃，不发明字段。 */
export function projectToSse(internal: {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}): SseEvent | null {
  const p = internal.payload;
  switch (internal.kind) {
    case 'trace':
      return { type: 'trace', trace_id: String(p['trace_id'] ?? '') };
    case 'session':
      return {
        type: 'session',
        session_id: String(p['session_id'] ?? ''),
        ...(p['workspace_id'] !== undefined ? { workspace_id: p['workspace_id'] } : {}),
        ...(p['conversation_id'] !== undefined ? { conversation_id: p['conversation_id'] } : {}),
        ...(p['session_reused'] !== undefined ? { session_reused: p['session_reused'] } : {}),
        ...(p['trace_id'] !== undefined ? { trace_id: p['trace_id'] } : {}),
      };
    case 'token':
    case 'message.delta':
      return { type: 'token', text: String(p['text'] ?? p['delta'] ?? '') };
    case 'tool_start':
    case 'tool.execution.started':
      return {
        type: 'tool_start',
        id: String(p['id'] ?? ''),
        name: String(p['name'] ?? ''),
        ...(p['args'] !== undefined ? { args: p['args'] } : {}),
      };
    case 'tool_end':
    case 'tool.execution.completed':
      return {
        type: 'tool_end',
        id: String(p['id'] ?? ''),
        name: String(p['name'] ?? ''),
        result: p['result'],
        ...(p['isError'] !== undefined ? { isError: p['isError'] } : {}),
      };
    case 'file_ready':
    case 'artifact.ready':
      return {
        type: 'file_ready',
        ...(p['artifact_id'] !== undefined ? { artifact_id: p['artifact_id'] } : {}),
        ...(p['path'] !== undefined ? { path: p['path'] } : {}),
        ...(p['name'] !== undefined ? { name: p['name'] } : {}),
        ...(p['mime_type'] !== undefined ? { mime_type: p['mime_type'] } : {}),
        ...(p['size'] !== undefined ? { size: p['size'] } : {}),
      };
    case 'approval_required':
      return {
        type: 'approval_required',
        approval_id: String(p['approval_id'] ?? ''),
        ...(p['tool_name'] !== undefined ? { tool_name: p['tool_name'] } : {}),
        ...(p['command'] !== undefined ? { command: p['command'] } : {}),
        ...(p['path'] !== undefined ? { path: p['path'] } : {}),
        ...(p['reason'] !== undefined ? { reason: p['reason'] } : {}),
        ...(p['risk_level'] !== undefined ? { risk_level: p['risk_level'] } : {}),
      };
    case 'done':
      return { type: 'done' };
    case 'session_closed':
      return {
        type: 'session_closed',
        ...(p['session_id'] !== undefined ? { session_id: p['session_id'] } : {}),
      };
    case 'error':
      return { type: 'error', message: String(p['message'] ?? '') };
    default:
      if (typeof p['type'] === 'string') return p as SseEvent;
      return null;
  }
}
