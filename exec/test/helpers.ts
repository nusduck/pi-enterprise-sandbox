/**
 * 隔离层测试的共享夹具。**不是**测试文件本身（不匹配 `*.test.ts`），
 * 供 `exec/test/isolation-*.test.ts` 导入。
 *
 * 关键点（W1-B 踩过的坑，这里一并绕开）：macOS 上 `os.tmpdir()` 落在
 * `/var/folders/...`，而 `/var` 是指向 `/private/var` 的符号链接。如果测试
 * 期望值用未展开的 `tmpdir()` 路径、实际值又经过了某处 `fs.realpath()`，
 * 两者会在字符串比较时对不上——不是逻辑错误，是符号链接展开的时机不一致。
 * 这里在创建任何子目录**之前**先对 scratch 根做一次 `realpath`，后续所有
 * `join()` 出来的路径天然就是展开后的形式，不需要每个测试再单独展开一次。
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnabledSkillPackage, WorkspaceContext } from '../src/types.js';

export interface TestWorkspace {
  /** realpath 展开过的 scratch 根，所有夹具路径都在它下面。 */
  readonly root: string;
  readonly context: WorkspaceContext;
  cleanup(): Promise<void>;
}

export interface MakeTestWorkspaceOptions {
  /** 要在磁盘上真实创建、并作为 `enabledSkillPackages` 挂进 context 的包名。 */
  readonly enabledPackages?: readonly string[];
  /** 只在磁盘上创建目录、但**不**加入 `enabledSkillPackages`——用来模拟
   * "已安装但未启用"的包，验证它不会被挂载。 */
  readonly installedButNotEnabledPackages?: readonly string[];
}

/** 创建一整套真实存在于磁盘上的 workspace/temp/skill 目录，返回对应的
 * `WorkspaceContext` 与一个 `cleanup()`。每次调用都是独立的 scratch 根，
 * 天然满足"不同会话的物理路径不同"这条断言需要的前提。 */
export async function makeTestWorkspace(
  options: MakeTestWorkspaceOptions = {},
): Promise<TestWorkspace> {
  const resolvedTmpRoot = await realpath(tmpdir());
  const base = await mkdtemp(join(resolvedTmpRoot, 'pi-isolation-'));

  const workspaceRoot = join(base, 'workspace');
  const tempRoot = join(base, 'temp');
  const systemSkillRoot = join(base, 'skills');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(systemSkillRoot, { recursive: true });

  const enabledSkillPackages: EnabledSkillPackage[] = [];
  for (const name of options.enabledPackages ?? []) {
    const pkgRoot = join(base, 'user-skills', name);
    await mkdir(pkgRoot, { recursive: true });
    enabledSkillPackages.push({ name, sourcePath: pkgRoot });
  }
  for (const name of options.installedButNotEnabledPackages ?? []) {
    const pkgRoot = join(base, 'user-skills', name);
    await mkdir(pkgRoot, { recursive: true });
    // 故意不 push 进 enabledSkillPackages。
  }

  const context: WorkspaceContext = {
    orgId: 'org_test',
    userId: 'user_test',
    workspaceId: `ws_${base.split('/').pop()}`,
    workspaceRoot,
    tempRoot,
    systemSkillRoot,
    enabledSkillPackages,
  };

  return {
    root: base,
    context,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

/** 一个永远不会在磁盘上存在的绝对路径，用来测"必须失败"的分支。 */
export function neverExists(label: string): string {
  return `/pi-isolation-test-never-exists/${label}/${Date.now()}-${Math.random()}`;
}

/**
 * `candidate` 是否等于 `root`，或者是 `root` 的后代路径。
 *
 * 按路径段比较，不用裸 `startsWith`——`'/a/bc'.startsWith('/a/b')` 是
 * `true`，但 `/a/bc` 根本不在 `/a/b` 底下，是同级的兄弟路径。这个函数是
 * "可写挂载必须落在 writableRoots() 之内"这条全局不变量测试的核心，
 * 判定错了这条不变量就是摆设。
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const candidateSegments = candidate.split('/').filter(Boolean);
  const rootSegments = root.split('/').filter(Boolean);
  if (candidateSegments.length < rootSegments.length) return false;
  return rootSegments.every((segment, i) => candidateSegments[i] === segment);
}
