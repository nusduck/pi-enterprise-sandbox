# Design

ADR 选择 upstream + Extension/custom tools。兼容 harness 创建固定模型/工具 stub，捕获 SDK event stream 与 JSONL，归一化时间/ID 后与 golden vectors 比较。

升级在独立分支运行 old/new matrix；新旧 Agent 镜像可短期用于版本验证，但业务迁移不允许双执行同一 Run。Session schema 先复制迁移并验证，可回滚 Agent 镜像。

退出条件：上游许可证变化、关键安全/持久化能力无法通过公开 API实现、维护停止或兼容成本超过经批准阈值；届时新 ADR 决定 fork/兼容层。

