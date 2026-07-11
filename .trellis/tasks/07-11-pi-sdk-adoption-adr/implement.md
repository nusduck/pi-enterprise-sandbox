# Implementation Plan

1. 编写 ADR，盘点使用中的 SDK imports/events/session fields/hooks。
2. 将依赖改为精确版本并验证 lockfile/Node engine。
3. 建立 deterministic SDK compatibility harness 与 golden vectors。
4. 覆盖 Extension block/result、built-in override、Session resume/branch/custom entry。
5. 编写升级、Session schema 验证和镜像回滚 runbook。
6. 将兼容套件加入 Agent package CI。

## Validation

```bash
node --test api-server/tests/*.test.js
npm ls --prefix api-server @earendil-works/pi-coding-agent
npm ci --prefix api-server
```

## Rollback Point

恢复上一精确版本与 lockfile，回滚 Agent 镜像；保留所有 compatibility 输出与原始 Session 事件。

