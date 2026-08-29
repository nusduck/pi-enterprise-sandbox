# W2-A：`exec/src/shell/` 命令执行器 🔄

继承 [`_shared.md`](_shared.md)。

## 范围
只改 `exec/src/shell/executor.ts` 及其拆分出的同目录文件 + `exec/test/shell-executor*.test.ts`。
**不碰** `job-registry.ts`（W2-B）、`exec/src/workspace/`（W2-C）、`fs/`、`isolation/`、`types.ts`。

## 交付
实现 `ctx.shell` 契约（先读 `exec/node_modules/@deepseek-ai/dsh-shell` 的 `.d.ts` 确认签名）：
- `run(spec)` —— 前台执行。**只在基础设施故障时 reject**；命令非零退出**不是** reject
- `start(spec)` —— 后台执行，立即返回 `ShellProcess`，**不套超时**
- `sandboxMode` —— 上报本执行器确保的模式

### 硬要求
1. **每一次 spawn 必须先过 `exec/src/isolation/`**，用 `render()` 出来的 argv。绝不允许存在绕开隔离层的 spawn 路径（ADR 0007 D11：Sandbox 是唯一安全边界）
2. **危险命令硬拒**：`sudo`/`su`/`rm -rf /`/`dd`/`mkfs`/`fdisk`/`chmod 777`，**在审批之前就拒**。移植自 `policy_checker.py` 的 `is_blocked_command`
3. **输出上限** stdout/stderr 各 50K 字符
4. **Python 代码物化**：短单行走 `python3 -c`，多行或超阈值先落工作区临时文件

### W1-C 交回来的缺口，归本任务补
`isolation/build.ts` 刻意不读 `process.env`，只在调用方给的 `envOverrides` 之上叠加隔离层必需的键。
**"把宿主 env 洗干净"是本任务的职责**：移植 `sandbox/security/safe_env.py` 的允许/拒绝清单与 `SANDBOX_EXEC_ENV_*` 前缀透传，放 `exec/src/shell/safe-env.ts`，**不要放进 `isolation/`**。

## 参考（只读）
`sandbox/services/execution_manager.py`（638 行）、`python_materialize.py`、`policy_checker.py`、`sandbox/security/safe_env.py`、`sandbox/utils/resource_limits.py`
