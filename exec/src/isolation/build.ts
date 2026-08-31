/**
 * 从一次执行请求构造 `IsolationProfile`（ADR 0008 D2 / D3 / D4）。
 *
 * 这是把 `WorkspaceContext` 翻译成"要 unshare 什么、挂什么、设什么环境变量、
 * 跑什么命令"的**唯一**地方。它是纯函数——不做任何文件系统访问（不 mkdir、
 * 不 stat），这样它才能被 `preflight.ts` 拿去构造一个不依赖真实会话的探针
 * profile，也才能在 macOS 开发机上不需要真实 workspace 目录就跑测试。
 *
 * 真正的"这个源路径存不存在、要不要先建"是运行时问题，由 `bubblewrap.ts`
 * 的 `resolveEffectiveMounts()` 在 spawn 前处理。
 *
 * 可写挂载**只**从 `writableRoots()` 派生（ADR 0008 D2）——本文件不自己算
 * 一遍"这个模式下什么能写"，这正是本次要消灭的"两边各算一遍"。
 */
import type { EnabledSkillPackage, SandboxMode, WorkspaceContext } from '../types.js';
import { writableRoots } from '../fs/writable-roots.js';
import {
  AGENT_PYTHON_VENV,
  AGENT_SKILL_PATH,
  AGENT_TEMP_PATH,
  AGENT_USER_SKILL_PATH,
  AGENT_WORKSPACE_PATH,
  AGENT_DRAFT_SKILL_PATH,
  IsolationConfigError,
  type IsolationProfile,
  type Mount,
  type NetworkMode,
} from './profile.js';

/** 计算可写根集合的函数签名，与 `writableRoots()` 完全一致。
 *
 * `writableRootsFn` 只在 `BuildProfileInput` 里作为可覆盖的注入点存在：
 * 生产路径永远不传它，永远吃默认值（真正的 `writableRoots()`）；唯一合法的
 * 使用者是 `preflight.ts` 的合成 profile（它的 workspace/temp 挂载反正会被
 * `toPreflightProfile()` 过滤掉，可写根算出来是什么根本不重要）和本目录的
 * 单元测试（W1-B 的 `writableRoots()` 现在还是一个 `throw`，测试需要替身）。
 * 不要在 `exec/src/shell/executor.ts` 之类的生产调用点传这个参数——那等于
 * 又长出了第二处"可写根计算"，正是 ADR 0008 D2 要消灭的东西。 */
export type WritableRootsFn = typeof writableRoots;

const DEFAULT_UID = 10001;
const DEFAULT_GID = 10001;

/** `_HOME_SUBDIRS`（`sandbox/isolation/bubblewrap.py:82-101`）：会话私有 XDG
 * home 的三个子目录，物理上挂在会话 temp 树下的 `.home/` 里，跟着 temp 的
 * 生命周期与配额走，不另开一个存储根（ADR 0004）。这条绑定语义原样保留，
 * 只是从一对 `--bind` 参数变成这里的三条 `Mount`。 */
const HOME_SUBDIRS: readonly { readonly relative: string; readonly logical: string }[] = [
  { relative: '.config', logical: '/home/sandbox/.config' },
  { relative: '.cache', logical: '/home/sandbox/.cache' },
  { relative: '.local/share', logical: '/home/sandbox/.local/share' },
];
const HOME_TREE = '.home';

/** 今天 `prepare()` 里那批静态只读 bind：容器镜像自带的运行时，与具体会话
 * 无关，`required: false`（源缺失是正常的部署形态差异，不是故障）。 */
const STATIC_RUNTIME_PATHS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr/local',
];

const STATIC_ETC_FILES: readonly string[] = [
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/ld.so.cache',
  '/etc/localtime',
];

/** 新命名空间内部要有的空目录（`--dir`）。今天 `preflight()` 漏了后五个，
 * 是 ADR 0008 D2 点名的分叉之一——这里是唯一定义处，不会再漏。 */
const STRUCTURAL_DIRS: readonly string[] = [
  '/run',
  '/home',
  '/home/sandbox',
  '/var',
  '/var/tmp',
  '/etc',
  '/app',
];

export interface BuildProfileInput {
  readonly context: WorkspaceContext;
  readonly mode: SandboxMode;
  /** 未净化的目标命令，例如 `["bash", "-c", "pwd"]`。 */
  readonly command: readonly string[];
  /** 相对 cwd，相对于 `cwdScope` 指向的根；默认 `"."`。不得以 `/` 开头或含 `..` 段。 */
  readonly relativeCwd?: string;
  /** 默认 `"workspace"`。 */
  readonly cwdScope?: 'workspace' | 'temp' | 'skill-draft';
  readonly envOverrides?: Readonly<Record<string, string>>;
  /** 默认 `"disabled"`（fail-closed：空 netns）。 */
  readonly networkMode?: NetworkMode;
  /** 默认 `true`。 */
  readonly dieWithParent?: boolean;
  /** 默认 `false`。 */
  readonly asPid1?: boolean;
  /** 默认 `0`（不限制）。 */
  readonly maxProcessCount?: number;
  readonly uid?: number;
  readonly gid?: number;
  /** 见上方 `WritableRootsFn` 的文档——生产路径不要传。 */
  readonly writableRootsFn?: WritableRootsFn;
}

function logicalCwd(relative: string, scope: 'workspace' | 'temp' | 'skill-draft'): string {
  if (relative.startsWith('/') || relative.split('/').includes('..')) {
    throw new IsolationConfigError('cwd must stay within a sandbox root');
  }
  const root =
    scope === 'temp'
      ? AGENT_TEMP_PATH
      : scope === 'skill-draft'
        ? AGENT_DRAFT_SKILL_PATH
        : AGENT_WORKSPACE_PATH;
  return relative === '' || relative === '.' ? root : `${root}/${relative}`;
}

function buildStaticMounts(ctx: Pick<WorkspaceContext, 'systemSkillRoot'>): Mount[] {
  const mounts: Mount[] = [];
  mounts.push({ kind: 'proc', target: '/proc', sessionSpecific: false });
  mounts.push({ kind: 'dev', target: '/dev', sessionSpecific: false });
  for (const target of STRUCTURAL_DIRS) {
    mounts.push({ kind: 'dir', target, sessionSpecific: false });
  }
  for (const path of STATIC_RUNTIME_PATHS) {
    mounts.push({
      kind: 'ro_bind',
      source: path,
      target: path,
      required: false,
      sessionSpecific: false,
    });
  }
  // 模型的 Python 运行库。源与 `safe-env.ts` 的 PATH 同出 `AGENT_PYTHON_VENV`。
  mounts.push({
    kind: 'ro_bind',
    source: AGENT_PYTHON_VENV,
    target: AGENT_PYTHON_VENV,
    required: false,
    sessionSpecific: false,
  });
  for (const path of STATIC_ETC_FILES) {
    mounts.push({
      kind: 'ro_bind',
      source: path,
      target: path,
      required: false,
      sessionSpecific: false,
    });
  }
  // 系统 skill 树是硬绑定：缺失是部署故障，要在启动前就说清楚（见
  // `bubblewrap.ts` 的 `resolveEffectiveMounts()`），而不是让 bwrap 用一句
  // "can't find source path" 带走 bash/python/pwd。
  mounts.push({
    kind: 'ro_bind',
    source: ctx.systemSkillRoot,
    target: AGENT_SKILL_PATH,
    required: true,
    sessionSpecific: false,
  });
  return mounts;
}

/** 逐包 `ro_bind`（ADR 0008 D4）：未启用的包根本不在 `mounts` 里，
 * 而不是"整个目录挂进去、靠 prompt 列表不提它"。`required: false` 保留今天
 * 那条来之不易的健壮性——一个包的挂载失败，不能让这个用户连 `pwd` 都用不了。 */
function buildSkillPackageMounts(packages: readonly EnabledSkillPackage[]): Mount[] {
  return packages.map((pkg) => ({
    kind: 'ro_bind',
    source: pkg.sourcePath,
    target: `${AGENT_USER_SKILL_PATH}/${pkg.name}`,
    required: false,
    sessionSpecific: true,
  }));
}

/** workspace 根、session 私有 temp 根：是否可写完全由 `writableRoots()` 决定
 * （ADR 0008 D2）。不在其中时仍然挂载——只是换成只读——因为 `read-only`
 * 模式的含义是"全盘只读"，不是"看不见"。 */
function buildRootMounts(
  ctx: WorkspaceContext,
  writable: ReadonlySet<string>,
): { mounts: Mount[]; tempWritable: boolean } {
  const tempWritable = writable.has(ctx.tempRoot);
  const mounts: Mount[] = [
    {
      kind: writable.has(ctx.workspaceRoot) ? 'bind' : 'ro_bind',
      source: ctx.workspaceRoot,
      target: AGENT_WORKSPACE_PATH,
      required: true,
      sessionSpecific: true,
    },
    {
      kind: tempWritable ? 'bind' : 'ro_bind',
      source: ctx.tempRoot,
      target: AGENT_TEMP_PATH,
      required: true,
      sessionSpecific: true,
    },
  ];
  // 草稿根（ADR 0009 D7 / 计划 H6.2）。是否可写**完全由 `writableRoots()` 决定**
  // ——这里不自己判一次，否则就是两处各算一遍（ADR 0008 D2）。
  // `ensureDir: true`：每用户一个持久目录，第一次用时还不存在。
  if (ctx.draftSkillRoot !== undefined && ctx.draftSkillRoot !== '') {
    mounts.push({
      kind: writable.has(ctx.draftSkillRoot) ? 'bind' : 'ro_bind',
      source: ctx.draftSkillRoot,
      target: AGENT_DRAFT_SKILL_PATH,
      required: false,
      ensureDir: true,
      sessionSpecific: true,
    });
  }
  return { mounts, tempWritable };
}

/** XDG home 三个子目录（ADR 0004）：物理源在会话 temp 树下的 `.home/`，
 * 第一次使用时可能还不存在——`ensureDir: true` 让 runner 在 spawn 前建好，
 * 而不是用会静默退回空 tmpfs 的 `--bind-try`（那正是 ADR 0004 要修的 bug）。
 * 是否可写跟随 temp 根本身的可写性，`read-only` 模式下不留一个隐藏的可写角落。 */
function buildHomeMounts(ctx: WorkspaceContext, tempWritable: boolean): Mount[] {
  return HOME_SUBDIRS.map(({ relative, logical }) => ({
    kind: tempWritable ? 'bind' : 'ro_bind',
    source: `${ctx.tempRoot}/${HOME_TREE}/${relative}`,
    target: logical,
    required: true,
    ensureDir: true,
    sessionSpecific: true,
  }));
}

const NETWORK_MODES: readonly NetworkMode[] = ['disabled', 'allowlist', 'unrestricted'];

export function buildIsolationProfile(input: BuildProfileInput): IsolationProfile {
  const networkMode = input.networkMode ?? 'disabled';
  if (!NETWORK_MODES.includes(networkMode)) {
    throw new IsolationConfigError(`Unsupported sandbox network mode: ${JSON.stringify(networkMode)}`);
  }

  const ctx = input.context;
  const cwdScope = input.cwdScope ?? 'workspace';
  const cwd = logicalCwd(input.relativeCwd ?? '.', cwdScope);

  const resolveWritableRoots = input.writableRootsFn ?? writableRoots;
  const writable = new Set(resolveWritableRoots(ctx, input.mode));

  const { mounts: rootMounts, tempWritable } = buildRootMounts(ctx, writable);

  const mounts: Mount[] = [
    ...buildStaticMounts(ctx),
    ...buildSkillPackageMounts(ctx.enabledSkillPackages),
    ...rootMounts,
    ...buildHomeMounts(ctx, tempWritable),
  ];

  const uid = input.uid ?? DEFAULT_UID;
  const gid = input.gid ?? DEFAULT_GID;

  return {
    namespace: {
      namespaces: networkMode === 'disabled' ? ['user', 'pid', 'ipc', 'uts', 'net'] : ['user', 'pid', 'ipc', 'uts'],
      uid,
      gid,
      asPid1: input.asPid1 ?? false,
      dieWithParent: input.dieWithParent ?? true,
      newSession: true,
      capDrop: 'ALL',
    },
    mounts,
    env: {
      clearEnv: true,
      vars: {
        ...input.envOverrides,
        HOME: '/home/sandbox',
        PWD: cwd,
        TMPDIR: AGENT_TEMP_PATH,
        XDG_CONFIG_HOME: '/home/sandbox/.config',
        XDG_CACHE_HOME: '/home/sandbox/.cache',
        XDG_DATA_HOME: '/home/sandbox/.local/share',
      },
    },
    launch: {
      argv: input.command,
      cwd,
      maxProcessCount: input.maxProcessCount ?? 0,
    },
  };
}
