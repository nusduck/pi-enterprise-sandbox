# 重新生成 schema manifest（改动迁移之后）

`contract/schema/schema-manifest.json` 是**由真实迁移重放生成**的快照，不是手写的。
Agent / Worker / exec 启动时按它核对目标库，`tests/test_schema_upspec_naming.py` 也读它
（UPspec 约束的是 DBA 最终看到的对象）。所以**改了 `agent/src/infrastructure/mysql/migrations/`
里的任何东西，就必须重新生成它**，否则 `schema-manifest.integration` 测试会红。

## 为什么必须在 compose 网络里跑

两个独立的坑，都在宿主机上跑时撞到：

1. **MySQL 的 root 只从容器内可连。** 容器里存在 `root@%` 与 `root@localhost`，但宿主机
   经 `127.0.0.1:3306` 连进去时服务端把它当 `localhost`，匹配到的那条账号与凭据对不上，
   直接 `Access denied`。`sandbox@%` 同理。用 `docker compose run` 从 compose 网络里连
   `mysql:3306` 才是稳的。
2. **`agent` 镜像的 `contract/` 是构建进去的，不是 bind mount。** 清单默认写在
   `/app/contract/schema/schema-manifest.json`，在容器里改它不会回到宿主机。所以要
   `-v` 挂一个宿主机可写目录，把清单写到那里再拷回来。

顺带：镜像里跑的是 `dist/`，所以**必须先 `docker compose build agent`**——只改源码不重建，
跑的还是旧迁移（症状是清单里少一张刚加的表，而命令返回 `ok: true`）。

## 步骤

```bash
# 1) 重建镜像，让新迁移进 dist/
BUILDX_CONFIG="$PWD/.runtime/buildx" docker compose build agent

# 2) 影子库必须为空。非空会被拒绝（刻意的：清单必须是全量重放的结果）
docker compose up -d mysql
docker compose exec -T mysql sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -e \
   "DROP DATABASE IF EXISTS dsh_schema_shadow; \
    CREATE DATABASE dsh_schema_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'

# 3) 从 compose 网络里全量重放，写到挂出来的目录
mkdir -p .runtime/schema-out
ROOT_PW="$(docker compose exec -T mysql printenv MYSQL_ROOT_PASSWORD)"
docker compose run --rm --no-deps -T \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/.runtime/schema-out:/out" \
  -e "SCHEMA_SHADOW_DATABASE_URL=mysql://root@mysql:3306/dsh_schema_shadow" \
  -e "SCHEMA_SHADOW_PASSWORD=${ROOT_PW}" \
  --entrypoint node agent \
  dist/src/infrastructure/mysql/cli-schema.js manifest --out /out/schema-manifest.json

# 4) 拷回仓库，然后必须核对 diff —— 只应出现你故意加/删的对象
cp .runtime/schema-out/schema-manifest.json contract/schema/schema-manifest.json
git diff --stat contract/schema/schema-manifest.json
```

`--user "$(id -u):$(id -g)"` 不是可选的：bind mount 出来的目录属主是宿主用户，
容器默认用户（1000）写不进去，症状是 `EACCES: permission denied`。

## 核对清单

生成完**不要直接提交**，先逐条确认（第 4 步的 diff 就是为这个）：

- [ ] 新增的表/索引/列**只有你这次故意加的**；`git diff` 里出现没预期的既有表变化 → 说明
      迁移写错了，不是清单的问题。
- [ ] 表名是 `tbl_agsvc_<业务名>`。**在 UPspec 改名迁移（`20260923000001`）之后新建的表
      必须直接建物理名**——改名那句话只处理它当时已知的表，事后建的表不会被改。
- [ ] 外键引用 `tbl_agsvc_<parent>.<col>`（物理名）。排在改名之后还引用逻辑名会
      `Cannot add foreign key constraint`。
- [ ] 索引名 `ind_agsvc_<abbr>_(a|i)<n>`，≤18 字节；`a` 唯一、`i` 非唯一；同一张表共用一个
      缩写，缩写**全库唯一**。
- [ ] ≤16 的字符串列用 `char`，不用 `varchar`。
- [ ] NOT NULL 列有 `DEFAULT`，除非命中豁免（主键、`_id`/`_by`/`_hash`/`_key`/`_digest`/
      `_subject`/`_provider`/`sha256`/`checksum`/`username`、JSON/TEXT 列）。

这些规则与 `tests/test_schema_upspec_naming.py` 一一对应——**先跑它**，比等集成测试快：

```bash
uv run pytest -q tests/test_schema_upspec_naming.py
```

## 收尾

```bash
uv run pytest -q          # 仓库卫生（含上面那条 + 清单一致性）
docker compose stop mysql
rm -rf .runtime/schema-out
```

`scripts/dev/schema-apply.sh` 是**空库初始化/升级**用的（它自己也会重放影子库并导出
分段 SQL 发布包到 `.runtime/schema-release`，再用 mysql 客户端逐段执行、最后核对清单）。
本 runbook 只解决「改完迁移怎么把清单更新掉」。
