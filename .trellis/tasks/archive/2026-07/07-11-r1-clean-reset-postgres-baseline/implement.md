# R1 实施计划

- [x] 为 migration checksum、幂等、失败回滚和 SQLite 空库写测试。
- [x] 实现版本化 baseline runner，移除启动时旧库 ALTER/backfill。
- [x] 为 reset preflight 的环境、确认串、项目标识和路径范围写失败测试。
- [x] 实现受限 development reset CLI 和 dry-run/preflight 输出。
- [x] 编写停机 reset/redeploy runbook，明确无备份/无迁移。
- [x] 运行专项、全量和 Compose 配置验证，记录 validation evidence。

## Validation

```bash
.venv/bin/pytest tests/test_database_baseline.py tests/test_development_reset.py -q
.venv/bin/pytest tests/ -q --tb=short
docker compose config -q
git diff --check
```

## Rollback

代码回滚不恢复已删除数据。实际 reset 失败时保持服务停止，修复后再次从空环境初始化；不调用 backup/restore。
