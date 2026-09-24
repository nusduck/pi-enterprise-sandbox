/**
 * 下游 readiness 探针的共用判定（K8s 部署评审 K1，2026-09-19）。
 *
 * BFF 的 `/health/ready` 以前访问 Agent 与执行面的 `/health`——那只是 liveness，
 * 下游「活着但未就绪」（执行面存储/数据库故障、Agent data plane 不可用、进入关停）
 * 时照样报 200。这里只认下游 `/ready`：HTTP 2xx **且** body `status === 'ready'`。
 * 两个条件缺一即未就绪；超时、网络错误、非 JSON 一律归为 unreachable。
 */

export type DownstreamReadiness =
  | { readonly status: 'ready'; readonly body: Record<string, unknown> }
  | { readonly status: 'not_ready'; readonly body: Record<string, unknown> }
  | { readonly status: 'unreachable'; readonly body: Record<string, unknown> };

export async function probeReadiness(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<DownstreamReadiness> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: 'unreachable', body: {} };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：按 HTTP 状态归类，body 留空。
  }
  if (resp.ok && body['status'] === 'ready') return { status: 'ready', body };
  return { status: 'not_ready', body };
}
