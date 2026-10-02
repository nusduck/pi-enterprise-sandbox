/**
 * `run.started` 事件里的 Skill 排除诊断（ADR 0015）。
 *
 * `resolveRunSkills` 产出 `diagnostics`（revoked / missing / mismatch /
 * `user_version_unusable` / `not_in_release` / `name_conflict` / policy_denied），
 * 但 `resolveRunSkillPaths` 只取 `discoverable`——诊断原来只写 Worker 日志。
 * 这里把它们投影成 `run.started` payload 的 `skillDiagnostics: [{ name, reason }]`：
 * 只放 Skill 名与原因码，不放路径、内容、摘要哈希。
 *
 * 诊断是可观测性：解析器缺省或抛错时记空数组，不挡 Run 启动。执行期的
 * fail-closed 语义不变（账本读失败仍由执行器按原逻辑让 Run 失败）。
 */

/** `run.started` payload 里的 Skill 排除项：只有名与原因码。 */
export interface RunSkillDiagnostic {
  readonly name: string;
  readonly reason: string;
}

/**
 * 把解析诊断投影成事件 payload 形状。
 *
 * 只取 `name` + 原因（`reason`，缺省时取解析器的 `code`）；其它字段（scope、
 * message、路径）一律丢掉，避免把发布存储细节带进事件流。名或原因缺失的条目
 * 丢弃——事件里不记半条诊断。
 */
export function projectSkillDiagnostics(
  entries: ReadonlyArray<{
    readonly name?: unknown;
    readonly code?: unknown;
    readonly reason?: unknown;
  }> | null | undefined,
): readonly RunSkillDiagnostic[] {
  if (!Array.isArray(entries)) return [];
  const out: RunSkillDiagnostic[] = [];
  for (const entry of entries) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    const reason =
      typeof (entry as { reason?: unknown })?.reason === 'string'
        ? String((entry as { reason?: unknown }).reason)
        : typeof entry?.code === 'string'
          ? entry.code
          : '';
    if (!name || !reason) continue;
    out.push(Object.freeze({ name, reason }));
  }
  return Object.freeze(out);
}

/**
 * 在写 `run.started` 之前算一次诊断。解析器可选：没配就记空数组；
 * 解析器抛错也记空数组——诊断失败不能让一次能跑的 Run 停在 QUEUED。
 */
export async function collectStartSkillDiagnostics(
  resolver:
    | ((input: { run: unknown; scope: { orgId: string; userId: string } }) => Promise<unknown>)
    | null
    | undefined,
  run: unknown,
  scope: { orgId: string; userId: string },
): Promise<readonly RunSkillDiagnostic[]> {
  if (typeof resolver !== 'function') return [];
  try {
    return projectSkillDiagnostics(
      (await resolver({ run, scope })) as Parameters<typeof projectSkillDiagnostics>[0],
    );
  } catch {
    return [];
  }
}
