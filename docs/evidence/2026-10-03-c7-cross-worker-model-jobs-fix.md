# C7 模型侧跨 Worker 作业查询修复（2026-10-03）

## 对象与前置红灯

- 分支：`test/c7-cross-worker-job-gate`，基于 `67f0f9c4`；本次运行包含尚未提交的修复。
- 前置复现见 [同日红灯证据](2026-10-03-c7-cross-worker-model-jobs-repro.md)：Worker B 的模型工具返回空列表、空输出和伪造的 running 快照；B Pod 直接调用 exec RPC 则读到真实状态与输出。
- 本次重建 `dsh-enterprise-agent:latest`（供 Agent HTTP 与 Worker 共用）和 `enterprise-sandbox:latest`，重新创建隔离的 `dsh-sim`（两 Agent Pod、两 Worker Pod、专用 MySQL/Redis/exec、假模型）。本次没有用真实模型，工具执行和 HMAC RPC 是生产代码路径。

## 修复后真链路

执行 `scripts/dev/k8s/up.sh sim`，再运行 `node scripts/dev/k8s/scenarios.mjs cross-worker-job`：首次 **4/4 通过**（tag `mus2i1fa`）。扩展场景加入模型侧跨 Worker `job_kill`，重建隔离栈后复跑 **5/5 通过**（tag `mus2v567`）。

- 背景 Run `01M40AEV1NPW93PF1ABMGA6WA3` 在 `agent-worker-577cbf8f9b-pgphl` 创建作业 `bash-c934f9ebe125429292a74bbc0d932873`；exec 持久行存在，场景读取时状态 `running`。
- 同一会话的后续 Run 落在另一 Pod `agent-worker-577cbf8f9b-9zr7v`。模型工具 `job_list` 的账本结果包含该作业及 `running` 状态；`job_output` 的账本结果包含 `C7_c7bg-mus2i1fa` 输出。`other_worker_sees_old_job_and_output` 通过。
- 第二次运行中，原 Worker `agent-worker-577cbf8f9b-68gsr` 创建 `bash-e86fd056a90b44f58895716417f622e3`；另一 Worker `agent-worker-577cbf8f9b-ddp5d` 完成 `job_list`/`job_output`。随后删除原 Worker Pod，模型侧 `job_kill` 仍由 `ddp5d` 发起并返回 `cancellation-requested`，exec 快照为 `killed: SIGTERM`。三个模型工具均通过跨 Worker 真链路。
- 测试后运行 `scripts/dev/k8s/down.sh sim`，隔离栈已清理。

## 范围

新 `/internal/v1/jobs/list` 沿既有 jobs HMAC 绑定，按 org/user/workspace 查询；模型侧 `job_list`、`job_output`、`job_kill` 现在等待 exec RPC，错误向工具结果传播，不再返回占位快照。定向离线测试覆盖三个工具的权威响应及读失败、列表路由的信封校验。exec 自身重启后的内存日志缓冲和活句柄恢复不在本次通过范围内，C7 继续记 `partial`。

## 回归

- Node 22 容器中 Agent `npm test`：2099/2099；exec 503 项（500 通过、3 跳过）、contract 157/157、api-server 319/319、frontend 713/713 在宿主运行通过，前端 build 通过；各包 TypeScript 类型检查通过，`docker compose config --quiet` 通过。
- `uv run pytest -q`：223/223。第一次运行被仓库里两个既有 `.agy-staff/jobs/*.result.md` 文件触发文档目录卫生门禁；临时移出仓库复跑后通过，文件随即原样放回。
- 宿主 Node 为 26，与 `runtime-versions.json` 要求的 22 不同；Agent 全套与重建镜像、K8s Worker 使用 Node 22。其余宿主套件的运行版本限制如上明示。

## 最终代码复验

收尾时补了远端模型工具输出的 `outputLimitBytes` 限制（出厂限制原先只查询本进程作业）。定向测试断言最终展示文本的 UTF-8 字节数不超过上限。再次重建 Agent HTTP/Worker 共享镜像后，Node 22 容器内 Agent 全套 **2099/2099**；再创建 `dsh-sim` 并运行同一场景 **5/5**（tag `mus32ge6`）。背景作业 `bash-53b9cfba935c4d409242ae4f2b0a0f23` 在 `agent-worker-577cbf8f9b-jd282` 启动；`agent-worker-577cbf8f9b-zh7mr` 的模型 `job_list`/`job_output` 读到真实结果。删除原 Pod 后，`zh7mr` 的模型 `job_kill` 返回 `cancellation-requested`，exec 快照为 `killed: SIGTERM`。验证后清理隔离栈。
