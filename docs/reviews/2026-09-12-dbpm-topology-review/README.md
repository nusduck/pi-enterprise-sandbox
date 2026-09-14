# UPDRDB / DBPM 与双集群拓扑方案复审

日期：2026-09-12。范围：`refactor/updrdb-dbpm`，提交 `57b9b6a1b66ea9c18f23315ffc3c2abb1cbc32ff`。

评审对象：[ADR 0011](../../adr/0011-updrdb-upredis-dbpm-migration.md)、[迁移方案](../2026-09-07-updrdb-dbpm/migration-plan.md)、[部署拓扑](../2026-09-07-updrdb-dbpm/deployment-topology.md)，以及这些方案依赖的当前生产代码、Compose、迁移和探针。

结论：**需要修改方案后再作为实施与部署依据。** 透传模式、保留 append-only 触发器、会话 UTC、两套独立 Redis、只在建连阶段切换 Proxy 的方向可以保留；“全部无状态”“并发抢占已经验证”“剩余问题均不阻塞”的表述超出了现有证据。

本次只新增 review 文档，没有实施数据库或拓扑迁移。已有 `2026-09-01-full-regression/` 下四个未提交文件未修改。历史探针输出仅作为历史材料；未连接内网 UPDRDB / UPRedis / DBPM，未在目标 VM 或双集群运行。以下明确区分代码事实与部署后果的静态推断。

## 发现与处置要求

后续处置已进入 [统一 design](../../design/updrdb-dbpm-deployment.md)：R1–R7 分别映射到设计及验收矩阵。共享存储可提供、入口按 HTTPS 设计已由用户确认；资源联调与代码实现仍未完成，以下发现不因设计修订自动关闭。

### R1 [P1] Agent 的 Skill 文件状态没有纳入跨集群存储设计

位置：拓扑 §3.7（214–232 行），尤其 Agent / Worker 无状态结论。

**代码事实**：`agent/src/bootstrap/http-main.ts:237` 的启用路径直接创建本机 SkillManager；`agent/src/skills/enablement.ts:160` 读取本机草稿，随后 `copyFile` 到本机发布目录并原子替换。Worker 的 `runtime-factory.ts:423` 使用本机 FileSystemSkillProvider。`docker-compose.yml:333`、`:433`、`:473` 为 Agent、Worker、sandbox 挂了共享 Skill 字节；草稿挂载旁还明确要求指向同一份字节。MySQL 启用表保存摘要和元数据，不保存完整包。

**后果（静态推断）**：VM 生成的草稿在 K8s Agent 上不可见；在 Agent A 上传/启用的包不自动出现在 Agent B、Worker 或 VM 上。没有持久卷的 Pod 重建也会丢失本地包。SSE 外置不能证明整项服务没有文件状态。

**要求**：在拓扑中明确系统 Skill 分发、草稿和发布包的权威存储、跨集群/VM 可见性及权限。选择共享存储，或另行设计执行面发布与按摘要分发协议；不能只把现有共享卷删掉。验收覆盖 VM 写草稿 → 另一集群启用 → 第三处 Worker 发现 → VM 执行 → Pod 替换后仍可用。

### R2 [P1] 全 HTTP 浏览器入口与生产 Secure Cookie 不兼容

位置：拓扑 §2 D3–D5（75–77 行）。

**代码事实**：`api-server/src/routes/auth.ts:16` 在 `DEPLOYMENT_ENV=production` 时生成 Secure Cookie，登录 JSON 只返回用户信息；`api-server/src/http/cookies.ts:20` 负责写该属性。普通 HTTP 内网域名不属于 localhost 例外，浏览器不会按所需方式保存/回传 Secure Cookie，见 [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)。

**后果（静态推断）**：登录接口可能返回 200，但 `/api/auth/me` 和后续受保护请求缺少会话，用户无法维持登录。内网是否考虑抓包不影响浏览器的协议规则。

**要求**：至少为浏览器入口设计 HTTPS 终止点，内部链路的加密决策可单独讨论。如坚持 HTTP，必须把认证适配及其风险作为显式的新设计，不能靠设置开发环境绕过整套生产校验。验收必须使用实际内网域名，而非 localhost。

### R3 [P1] Cron 的 claim-then-read 没有完成事务与恢复设计，探针也未验证并发

位置：迁移方案 P0-1（114–132 行）、ADR D3。

**代码事实**：`cron-job-repository.ts:258` 锁定的是 `cron_jobs`；该表没有 `claim_token` 列。`CronJobService.claimDue()` 在同一事务中读到期计划、判定 misfire / concurrency、写 `cron_job_runs` 并推进 `next_run_at`。这与带 PENDING/PUBLISHING 状态的 `domain_outbox` 不是同一套状态机。`probe/updrdb_recheck.py:129` 先执行 A 并 commit，随后才执行 B；它证明顺序条件更新不会重复命中，不证明同时争抢时的等待、吞吐或死锁表现。

**后果（静态推断）**：按当前一句 SQL 实施 Cron 会缺列；若先提交 claim 再单独推进 schedule，则新增了崩溃窗口和孤儿 claim。现有唯一键能挡重复 execution，不能自动解决计划推进、claim 回收与手动运行的竞争。

**要求**：分别写明 outbox 与 Cron 的 SQL、必要新增列/索引、事务边界、claim 释放/过期规则，并保留 `forbid` 与 `skip` 语义。并发测试用同步屏障让两个事务真正重叠，覆盖批量竞争、锁等待超时、claim 后进程退出、手动运行与定时触发竞争。更新证据措辞，不再称该串行探针为并发验证。

### R4 [P1] 手工 DDL 后的启动校验不足以保障完整 schema 与安全约束

位置：迁移方案 P0-5（200–210 行）。

**代码事实**：拟使用的 `schema-tables.ts` 只包含部分表名，没有完整列/索引/触发器定义；其中不含 `cron_jobs`、`user_skill_enablements`、`exec_jobs` 等后续迁移表。方案只明确接入 Agent 启动，但新拓扑中 Worker、VM exec 是独立启动单元。手工填写的 `knex_migrations` 记录不是对象确实存在或正确的证明。

**后果（静态推断）**：即便版本记录齐全，漏掉 append-only 触发器、唯一索引或后加列，也可能被这套校验放行。某个服务启动成功不等于另外两个独立进程使用的 schema 已通过检查。

**要求**：从权威迁移产物建立可核对的 schema 清单，包含所需表/列、关键类型、唯一键、外键和四个触发器；明确验证账号可见的元数据权限。Agent、Worker、exec 在提供服务/消费任务前各验证所需对象。SQL 导出还需规定参数绑定、触发器脚本分隔符、首装/增量、失败停止和成功后记账规则，不能只描述为捕获 query。验收包括“版本记录完整但删掉一个安全约束/后续表时必须拒绝启动”，并用合法写入证明不是全部拒绝。

### R5 [P1] 开发基线降到 MySQL 5.7 时没有隔离现有 MySQL 8 数据卷

位置：迁移方案阶段 1（532–541 行）。

**代码事实**：Compose 把 `${MYSQL_DATA_VOLUME:-mysql_dev_data}` 挂在 `/var/lib/mysql`，计划只写了换镜像与启动参数，没有规定换新卷。MySQL 官方明确 [不支持从 8.0 降至 5.7](https://dev.mysql.com/doc/refman/8.0/en/downgrading.html)。

**后果（静态推断）**：已有开发环境照步骤执行时，5.7 会尝试使用 8.0 的数据目录，不能作为正常迁移路径。“无生产数据”不等于开发数据库没有数据。

**要求**：5.7 使用独立的新卷，保留旧卷和旧镜像作为开发回退点；需要保留的数据另定导出/导入验收。不要通过 `down -v` 清空现有环境。独立 PR 的阶段 1 明知会使 SKIP LOCKED 测试失败，也不宜先合入共享基线；与适配组成一个可通过验收的交付阶段。

### R6 [P1] VM 裸装清单没有覆盖隔离进程实际使用的工具路径

位置：拓扑 §4.2(c)、§4.3（270–315 行）。

**代码事实**：文档只列了两个硬编码路径，但 `exec/skill-runtime/baoyu-format-markdown` 与 `baoyu-markdown-to-html` 还硬编码 `/usr/local/bin/bun` 和 `/usr/local/lib/pi-skill-runtime/...`；`baoyu-chromium` 指向 Debian 的 `/usr/lib/chromium/chromium`。`safe-env.ts:36` 为子进程设置固定 PATH 与 `/usr/local/lib/node_modules`。`isolation/build.ts` 挂载 `/usr` 等目录以及特定 Python venv，不挂整个 `/opt`。

**后果（静态推断）**：Node tarball 装在 `/opt` 可以启动服务，却不代表 bwrap 内能运行 Node；全局安装若落在其他 prefix，办公工具也找不到模块。直接搬 Debian Chromium 包装脚本到麒麟可能找不到二进制。单纯 namespace 体检通过不能证明这些工具可用。

**要求**：从 Dockerfile、三个 wrapper、safe-env 和实际 mount 清单整理 VM 安装清单，明确安装 prefix、Skill runtime 锁定依赖、Python 版本和 Chromium 可执行路径。用生产执行入口在 bwrap 内验证 Node/Python/Bun、两个 BaoYu wrapper、浏览器及四种办公产物，不能只在宿主机验证命令存在。

### R7 [P2] Redis 验收门槛仍测试旧的 key 布局，修复后也无法可靠放行

位置：迁移方案阶段 5（569–572 行）。

**代码事实**：计划要求 Python 探针退出 0 才继续，但 `upredis_probe.py:516` 固定使用 `__probe:<timestamp>:`，`:346` 的 14-key 脚本没有 hash tag，也没有 prefix 参数。应用配置改成 `{bull}` 不会改变探针。脚本清理还用跨 key 的批量 DEL，异常被吞掉，不能保证分片代理下自清理。

**后果（静态推断）**：目标代理仍可能拒绝探针的旧布局，即使修复后的 BullMQ 正常，发布门槛仍然报红；探针可能遗留测试 key。Node 版探针也仍把零 key EVAL 拒绝当作全盘 Lua 失败，不能替代修复后验收。

**要求**：区分兼容性负向探测和放行测试：旧 key 布局的预期拒绝保留为对照，放行路径使用与生产一致的 prefix，真实跑 Queue/Worker 的投递、延迟、重试和 stalled 恢复。清理按同 slot 或单 key 执行，并检查无残留。

## 非独立阻塞项与待验证边界

- Proxy 粘主和“不重试已发送写语句”合理，但 Knex 的函数式 connection 只是配置供应器，本身不接收握手失败。实现计划需明确捕获哪个建连错误来拉黑节点、如何通知池及约束总超时；仅有选择器单测不能证明生产接线可切换。
- 双集群不等于整栈高可用：当前单 VM 和本地字节仍是公共故障点。应明确可接受中断、备份恢复和发布时活跃进程处置；不要求为了这次部署盲目加副本。
- VM 尚未体检的限制已在 §4.0 写明，应保留；这不是本轮新发现，也不能记成通过。
- “Redis 升级换不来任何东西”应改成受限结论。历史短测支持选定场景的兼容性，不能证明所有性能与故障行为等价；厂商是否维护安全补丁也不能由上游版本号或内网属性单独推导。noeviction 需覆盖实际后端并持久生效，见 [BullMQ 生产建议](https://docs.bullmq.io/guide/going-to-production)。
- 建议移除“为了少找 DBA，优先 JSON/加列而不建表”的普遍设计偏好；数据约束和查询需求应决定 schema，人工发布步骤不能替代领域建模。

## 建议实施顺序与验收

1. 先补 R1 的 Skill 存储契约与 R2 的浏览器入口协议；这两项决定拓扑是否成立。
2. 完成 R3/R4 的事务、迁移导出和启动验证设计；R5 将开发数据库切换变为可恢复操作。
3. 数据库阶段实施时修正 R7 放行探针；VM 到手后按 R6 验证完整工具链。保留既有隔离、租户、触发器和凭据护栏。
4. 最终必须在实际目标形态验收：双集群跨 Pod 的上传/Skill/会话，Proxy 故障和 Worker 恢复，真实 DBPM 启动失败对照，VM 执行与进程 logs/signal、跨租户 404。Docker 本地测试不等价于裸装 VM 验证。

R1–R6 是方案修订/部署前必须关闭的事项，R7 是放行工具修订项；全部留在本报告的实施前清单，不转入非阻塞债务。尚无实现或目标环境证据，故不改变 `docs/STATUS.md` 状态。

## 本次验证记录

- 方式：只读核对 Git、源码、迁移、Compose、现有探针及官方协议资料；没有执行会写目标数据库的探针。
- 应用 runtime：本轮未运行应用或升级依赖；宿主 Node 为 v26.5.0，不能冒充仓库规定的 Node 22 验收。
- 仓库卫生检查：`uv run python --version` = Python 3.11.15，符合版本钉；`uv run pytest -q tests/test_repository_layout.py tests/test_runtime_versions.py` = **28 passed in 1.57s**；`git diff --check` 通过。卫生结果不代表目标拓扑或业务链路通过。
- 未执行六套业务测试、容器重建、浏览器及内网真实链路：本轮是方案 review，无生产代码修改，按 AGENTS.md §4 不要求启动全栈；因此不宣称运行验收通过。
