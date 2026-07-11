# R7 CI 与无密钥跨服务 E2E

## Goal

统一 Node 22 并建立无需真实 LLM key 的启动、数据库、协议和完整四服务门禁。

## Requirements

- BFF、Agent、Frontend、Sandbox Node runtime 和 CI 统一 Node 22。
- BFF/Agent 增加真实 import/listen smoke。
- Deterministic fake OpenAI-compatible provider 只供测试，production 禁止。
- CI 覆盖空 PostgreSQL、相对 workspace、100 路事件并发、生产配置、SSE/工具/审批/附件/取消/Artifact/重启恢复。

## Acceptance Criteria

- [x] 干净依赖安装下全部 package tests/build 和 Compose config 通过。
- [x] 无真实模型 key 的四服务 E2E 稳定、可重复。
- [x] Production 无法启用 fake provider。
- [x] CI/镜像 Node 主版本完全一致。
