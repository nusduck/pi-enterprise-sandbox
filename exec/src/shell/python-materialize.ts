/**
 * Python 代码物化——移植自 `sandbox/services/python_materialize.py`。
 *
 * 规则不变：
 * - 短单行代码（无换行、UTF-8 字节数 ≤ 阈值）走 `python3 -c <code>`；
 * - 多行或超阈值：原子写入工作区 `.runtime/python/{executionId}.py`，
 *   跑 `python3 -u <逻辑路径>`；
 * - **绝不** shell-quote 代码或参数——argv 永远是数组，没有注入面；
 * - 物化出来的脚本是工作区里的中间文件，不是 artifact。
 *
 * 与 Python 版的差异（如实记录，见交付报告）：
 * - 不做工作区配额检查（Python 版 `_enforce_workspace_quota()`）。配额是
 *   `exec/src/workspace/`（W2-C）的职责范围，这里只负责"物化"这一件事；
 *   调用方如果需要配额闸门，应该在调这个函数之前自己查。
 * - 物化路径的物理落盘直接用 `node:fs`，不经过 `exec/src/fs/`
 *   （`WorkspaceFileSystem`）——原因是这份代码本来就不是"模型可见的文件
 *   操作"，是执行器内部的实现细节（Python 版同理，`execution_manager.py`
 *   也是直接 `pathlib` 写盘，不经过它自己的 `file_manager` 服务）。
 * - 逻辑路径固定用 `AGENT_WORKSPACE_PATH`（bwrap 模式下的沙箱内路径）；
 *   Python 版还留了一条"非 bubblewrap backend 用物理路径"的分支
 *   （`isolation_backend != "bubblewrap"` 时 `guest_path = str(physical)`），
 *   这条本次不搬——ADR 0008 只剩 Bubblewrap 一种隔离后端，没有第二条路径
 *   需要兼容，且直接抛物理路径给沙箱内命令本来就违反"物理路径不外泄"的
 *   纪律，是移植时发现的一处可以直接修掉的旧实现问题。
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { AGENT_WORKSPACE_PATH } from '../isolation/profile.js';

/** 与 Python 版 `PYTHON_INLINE_MAX_BYTES` 对齐（plan §13.6 建议阈值）。 */
export const PYTHON_INLINE_MAX_BYTES = 2048;
/** 与 Agent 侧 `MAX_PYTHON_CODE_BYTES` 对齐。 */
export const PYTHON_CODE_MAX_BYTES = 256 * 1024;
export const PYTHON_ARGS_MAX = 32;
export const PYTHON_ARG_MAX_LEN = 1024;

const SAFE_EXEC_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RUNTIME_REL_DIR = path.posix.join('.runtime', 'python');

/** 调用方传入的参数/代码不合法时抛出——由调用方（`executor.ts`）捕获并
 * 转换成"这次调用的结果"，不是基础设施故障。 */
export class PythonMaterializeError extends Error {
  override readonly name = 'PythonMaterializeError';
}

export interface PythonLaunchPlan {
  readonly argv: readonly string[];
  /** 沙箱内逻辑路径（`/home/sandbox/workspace/.runtime/python/xxx.py`），
   * `mode === 'inline'` 时为 `undefined`。 */
  readonly materializedPath?: string;
  /** 物理落盘路径，仅用于测试/审计；不得出现在任何面向模型/前端的响应里。 */
  readonly physicalPath?: string;
  readonly mode: 'inline' | 'file';
  readonly codeBytes: number;
}

/** 短单行代码（无换行、不超阈值）走 `-c`；否则必须物化成文件。 */
export function shouldMaterialize(code: string): boolean {
  if (typeof code !== 'string') return true;
  if (code.includes('\n') || code.includes('\r')) return true;
  return Buffer.byteLength(code, 'utf-8') > PYTHON_INLINE_MAX_BYTES;
}

/** 校验并原样返回 argv 风格的参数（不做任何 shell 解析）。 */
export function normalizePythonArgs(args?: readonly string[]): string[] {
  if (!args || args.length === 0) return [];
  if (args.length > PYTHON_ARGS_MAX) {
    throw new PythonMaterializeError(`python args exceed max count (${PYTHON_ARGS_MAX})`);
  }
  const out: string[] = [];
  args.forEach((raw, i) => {
    if (typeof raw !== 'string') {
      throw new PythonMaterializeError(`python args[${i}] must be a string`);
    }
    if (raw.includes('\x00')) {
      throw new PythonMaterializeError(`python args[${i}] contains NUL`);
    }
    if (raw.length > PYTHON_ARG_MAX_LEN) {
      throw new PythonMaterializeError(`python args[${i}] exceeds max length (${PYTHON_ARG_MAX_LEN})`);
    }
    out.push(raw);
  });
  return out;
}

function validateExecutionId(executionId: string): string {
  const text = (executionId ?? '').trim();
  if (!text || !SAFE_EXEC_ID_RE.test(text)) {
    throw new PythonMaterializeError('invalid executionId for python materialization');
  }
  return text;
}

/** 同目录临时文件 + `rename` 的原子写——对应 Python 版
 * `tempfile.mkstemp` + `os.replace`。`rename` 在同一文件系统内是原子的。 */
async function atomicWriteUtf8(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmpName = path.join(dir, `.py_mat_${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpName, text, { encoding: 'utf-8', flag: 'wx' });
    await rename(tmpName, filePath);
  } catch (err) {
    await rm(tmpName, { force: true });
    throw err;
  }
}

/** `physical` 是否落在 `root` 之内（纯路径比较，不 `realpath`——物化目标
 * 这时可能还不存在，且我们自己拼的路径本来就该在 root 之下，符号链接
 * 逃逸不是这个函数要防的攻击面：`root` 是可信的 `WorkspaceContext` 字段，
 * `executionId` 已经被 `validateExecutionId()` 收紧到白名单字符集）。 */
function isWithin(root: string, physical: string): boolean {
  const rel = path.relative(root, physical);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface PlanPythonLaunchInput {
  readonly code: string;
  readonly executionId: string;
  /** 物理工作区根（`WorkspaceContext.workspaceRoot`）。 */
  readonly workspaceRoot: string;
  readonly args?: readonly string[] | undefined;
}

/**
 * 构造一份安全的 python3 argv，必要时把代码物化到工作区。
 * 校验失败（代码非法/超限、参数非法/超限）抛 `PythonMaterializeError`；
 * 调用方据此在 `run()`/`start()` 里产出一个"调用失败"的结果，而不是
 * 让异常穿透到基础设施故障那一层。
 */
export async function planPythonLaunch(input: PlanPythonLaunchInput): Promise<PythonLaunchPlan> {
  const { code } = input;
  if (typeof code !== 'string') {
    throw new PythonMaterializeError('code must be a string');
  }
  if (code.includes('\x00')) {
    throw new PythonMaterializeError('code must not contain NUL');
  }
  const codeBytes = Buffer.byteLength(code, 'utf-8');
  if (codeBytes === 0 || !code.trim()) {
    throw new PythonMaterializeError('code is required');
  }
  if (codeBytes > PYTHON_CODE_MAX_BYTES) {
    throw new PythonMaterializeError(`code exceeds max size (${PYTHON_CODE_MAX_BYTES} bytes)`);
  }

  const execId = validateExecutionId(input.executionId);
  const argvArgs = normalizePythonArgs(input.args);

  if (!shouldMaterialize(code)) {
    return {
      argv: ['python3', '-c', code, ...argvArgs],
      mode: 'inline',
      codeBytes,
    };
  }

  const relFile = path.posix.join(RUNTIME_REL_DIR, `${execId}.py`);
  const physical = path.resolve(input.workspaceRoot, relFile);
  if (!isWithin(path.resolve(input.workspaceRoot), physical)) {
    throw new PythonMaterializeError('materialized path escapes workspace');
  }

  await atomicWriteUtf8(physical, code);

  const logical = `${AGENT_WORKSPACE_PATH}/${relFile}`;

  return {
    argv: ['python3', '-u', logical, ...argvArgs],
    materializedPath: logical,
    physicalPath: physical,
    mode: 'file',
    codeBytes,
  };
}
