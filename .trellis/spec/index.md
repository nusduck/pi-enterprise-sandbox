# 项目规范入口

本目录记录当前仓库**已经存在**的架构与实现习惯，供后续 Trellis 任务加载。内容以当前代码、配置和 CI 为准；`docs/` 与 `CONTRIBUTING.md` 用作补充证据，但其中已有少量过期描述。

## 阅读顺序

1. [project-architecture.md](project-architecture.md)：系统边界、目录职责、数据流、构建与测试入口。
2. [backend/index.md](backend/index.md)：Python Sandbox 与 Node API Server 规范。
3. [frontend/index.md](frontend/index.md)：Vanilla JavaScript SPA 规范。
4. [guides/index.md](guides/index.md)：Trellis 通用思考指南。

## 事实优先级

发生冲突时按以下顺序判断当前事实：

1. 可执行配置与当前源码：`pyproject.toml`、`package.json`、Dockerfile、Compose、CI、`sandbox/`、`api-server/`、`frontend/src/`。
2. 当前测试：`tests/`。
3. 活跃文档：`README.md`、`CONTRIBUTING.md`、`docs/`。
4. `docs/archive/` 与历史计划只用于理解背景，不能作为当前实现依据。

## 不确定信息的写法

- 无法从仓库确认的团队偏好统一标记为 **待确认**。
- 不把 `CONTRIBUTING.md` 中的“推荐”工具误写成 CI 强制门禁。
- 不把历史文档中的已删除目录或旧依赖写成当前结构。

