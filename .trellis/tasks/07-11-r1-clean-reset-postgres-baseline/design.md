# R1 技术设计

## 空库基线

`sandbox.database` 使用不可变 migration 列表初始化数据库。首个版本 `0001_baseline` 包含完整空 schema；`schema_migrations(version, checksum, applied_at)` 在同一事务中记录版本。已应用版本 checksum 不一致立即失败，未提交的 migration 不写版本记录。启动初始化不再自动执行 ownership/session 旧库 ALTER 或数据回填，也不创建 bootstrap 用户。

PostgreSQL 是生产目标；SQLite 仅使用同一份空库结构做开发和单测。两种 backend 都允许对已经按当前版本初始化的空/新库重复调用，结果不变。旧 migration helper 不属于启动路径，也不构成旧数据升级承诺。

## 研发 Reset

新增 Python reset CLI，校验全部条件后才产生副作用：

- `DEPLOYMENT_ENV` 必须精确为 `development`；
- 项目标识必须精确为编译期常量 `pi-enterprise-sandbox`；
- confirmation 必须精确匹配 `RESET pi-enterprise-sandbox DEVELOPMENT DATA`；
- SQLite 文件、workspace、attachment 必须位于非根、非空的 allow root 内；
- PostgreSQL database name 必须匹配显式 expected database name。

Preflight 先生成结构化清单；任一检查失败不连接数据库、不删除文件。SQLite 删除 db/WAL/SHM 后清理两个状态目录；PostgreSQL 在事务中重建项目 schema，再清理状态目录。Skill package 由 R8 单独处理，避免两个子任务重复拥有同一删除动作。

## 切换

Runbook 固定为停止四服务 → preflight → reset → 部署 → 初始化空 PostgreSQL → 创建管理员 → smoke。研发阶段不备份、不迁移、不恢复旧数据；失败保持停机并从空环境重试。
