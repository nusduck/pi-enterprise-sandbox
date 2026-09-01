/**
 * 可写根的**单一事实源**（ADR 0008 D2）。
 *
 * 文件围栏（WorkspaceFileSystem）与 bwrap 的 MountPlan 都必须由这里派生，
 * 不得各算一遍。上游 dsh-fs-sandbox 给出的理由原文：
 * "so the fs fence and the bash runner cannot drift"。
 *
 * 由 W1-B 实现；W1-C 只消费，不要另写一份。
 */
import type { SandboxMode, WorkspaceContext } from '../types.js';
import { canonicalizePath } from './path-policy.js';

/**
 * 返回该模式下允许写入的物理根，顺序稳定。
 *
 * - `read-only`          → 空
 * - `workspace-write`    → [workspaceRoot, tempRoot, draftSkillRoot?]
 *
 * **草稿根（ADR 0009 D7 / 计划 H6.1）只加在这一处。** fs 围栏与 bwrap 的
 * MountPlan 都从这里派生（ADR 0008 D2），所以「哪些地方能写」永远只有一个答案。
 * 在 build.ts 里另外判一次「草稿根要不要 bind」就是让两处各算一遍——
 * 那正是 ADR 0008 D2 立这条规矩要防的事。
 */
export function writableRoots(
  ctx: WorkspaceContext,
  mode: SandboxMode,
): readonly string[] {
  if (mode === 'read-only') return [];
  const roots = [ctx.workspaceRoot, ctx.tempRoot];
  if (ctx.draftSkillRoot !== undefined && ctx.draftSkillRoot !== '') {
    roots.push(ctx.draftSkillRoot);
  }
  return roots;
}

/**
 * 把 `writableRoots()` 返回的根规范化成 containment 比较时真正要用的形式
 * （symlink 解析后的绝对路径）。与 W1-B 的 fs 围栏（`workspace-fs.ts`）共用；
 * 单独导出是因为 W1-C 的 preflight/plan 断言（ADR 0008 验证要求 1）大概率
 * 也需要对同一批根做同样的规范化比较，不要各写一份。
 *
 * 失败（根还不存在）时原样返回而不是抛错——保守选择，一个不存在的根不会
 * 被误判为"包含"任何路径。
 */
export async function canonicalWritableRoots(
  ctx: WorkspaceContext,
  mode: SandboxMode,
): Promise<readonly string[]> {
  return Promise.all(writableRoots(ctx, mode).map((root) => canonicalizePath(root)));
}

/**
 * 可读根：工作区、temp、系统 skill、草稿、已启用包。
 *
 * `resolve()` / `lstat()` / `read` 走这里，不是 `writableRoots()`——系统 skill
 * 只读但必须能 `read /home/sandbox/skill/README.md`。用可写根做 resolve 围栏
 * 就是 2026-09-01 那次「bash 能 ls、read 报 path escape」的成因。
 */
export function readableRoots(ctx: WorkspaceContext): readonly string[] {
  const roots = [ctx.workspaceRoot, ctx.tempRoot, ctx.systemSkillRoot];
  if (ctx.draftSkillRoot !== undefined && ctx.draftSkillRoot !== '') {
    roots.push(ctx.draftSkillRoot);
  }
  for (const pkg of ctx.enabledSkillPackages) {
    roots.push(pkg.sourcePath);
  }
  return roots;
}

export async function canonicalReadableRoots(
  ctx: WorkspaceContext,
): Promise<readonly string[]> {
  return Promise.all(readableRoots(ctx).map((root) => canonicalizePath(root)));
}
