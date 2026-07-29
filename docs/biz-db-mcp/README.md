# biz-db-mcp — 业务 MySQL 只读访问 MCP 服务（设计 + 骨架代码）

## 背景 / 目标

场景：Agent 需要连业务 MySQL（只读账号，IP 白名单，内网部署，用户可信）做 SQL
查询，并把 10 万～100 万行级别的数据下载到本地用 pandas 做复杂分析。

**不采用**的方案：把数据库地址/账号/密码直接作为 env 变量打进 Sandbox 容器。
Sandbox 是 `bash`/`python` 工具执行任意 agent 生成代码的地方，任何一次
prompt injection 或误操作都能读到 `os.environ` 拿到密码；所有 session 共享
同一条账号，出问题也没法按会话审计或单独撤销。

**采用**的方案：新增一个独立的 MCP Server（`biz-db-mcp`），只有它持有真实的
MySQL 密码；Sandbox 全程不接触密码，只通过已有的 Dataset 接口接收导出结果。
这是本仓库已有模式的直接复用，不是新发明：

- Agent 的 MCP 接入本来就要求密钥只能是 `secretRef`（见
  `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js` 的
  `loadMcpServerRegistry`/`createEnvironmentSecretResolver`），明文密钥会直接
  校验失败。
- Sandbox 已有 `POST /sessions/{session_id}/datasets`
  （`sandbox/routers/datasets.py`），用「service token + acting headers」
  这套既有的可信内部调用模式即可写入 Dataset，不需要新增 Sandbox 接口。
- MCP tool result 在本仓库里本来就有 1MB 硬顶
  （`MCP_TOOL_RESULT_MAX_JSON_BYTES`），批量数据必须走文件落盘而不是塞进
  tool result，这也是 `export` 工具存在的原因。

## 架构

```
Agent (内网, 只持有指向 biz-db-mcp 的 secretRef)
  │  MCP tool call: mcp__bizdb__{describe_table,query,export}
  ▼
biz-db-mcp（新增服务，持有真正的 MySQL 只读账号密码）
  │
  ├─ describe_table / query → 直接查询业务库，小结果集当 tool result 返回
  │
  └─ export → 服务端游标流式查询 → 边查边写 Parquet（有界内存）
                        │
                        ▼ service token + X-Acting-{Org,User}-Id
              POST /sessions/{id}/datasets  (Sandbox 已有接口)
                        │
                        ▼
              Sandbox workspace 出现一个 Dataset 文件
                        │
Agent 的 python 工具：pd.read_parquet(本地路径) 做复杂分析
```

## 目录结构

```
docs/biz-db-mcp/
  README.md              # 本文档
  skeleton/
    pyproject.toml
    biz_db_mcp/
      config.py          # env 驱动的配置（DSN/token 只来自 env，不接受明文参数）
      sql_guard.py        # SELECT-only 静态检查（纵深防御，独立于账号只读权限）
      db.py               # pymysql 只读连接：describe_table / query / stream_query
      export.py           # 流式 Parquet 写入，批次写盘，内存不随行数线性增长
      sandbox_client.py   # 把导出文件推成 Sandbox Dataset
      audit.py            # 每次调用的结构化审计日志
      server.py           # MCP 工具注册（FastMCP，stdio transport）
```

代码是骨架（skeleton）：核心逻辑（SELECT-only 检查、流式导出、Dataset 推送）
是完整可跑的，但部署相关的一些点（见下面「待决问题」）需要结合实际环境定稿，
故意没有替你悄悄假设。

## 三个工具的契约

| 工具 | 用途 | 返回 |
| --- | --- | --- |
| `describe_table(table)` | 查看表结构 | 列信息（小） |
| `query(sql, params?, limit?)` | 探索性小查询 | 行数据，硬顶 `BIZDB_QUERY_MAX_ROWS`（默认 200） |
| `export(sql, dataset_name, session_id, org_id, user_id, params?, conversation_id?)` | 批量导出 10万～100万行级别数据 | `{dataset_id, row_count, size_bytes, ...}`，**不返回原始数据** |

`query` 和 `export` 都会先过 `sql_guard.assert_select_only()`：只允许单条
`SELECT`（或 `WITH ... SELECT`），拒绝任何 DML/DDL 关键字、拒绝多语句拼接。
这是账号只读之外的第二层防御，不依赖数据库权限。

## 配置（全部走环境变量，不接受明文命令行参数）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `BIZDB_MYSQL_DSN` | 是 | `mysql://user:pass@host:port/db`，只读账号 |
| `BIZDB_SANDBOX_BASE_URL` | 是 | Sandbox 内部地址，例如 `http://sandbox:8000` |
| `BIZDB_SANDBOX_API_TOKEN` | 是 | 推送 Dataset 用的 service token |
| `BIZDB_SANDBOX_API_TOKEN_HEADER` | 否，默认 `X-API-Key` | service token 的 header 名 |
| `BIZDB_QUERY_MAX_ROWS` | 否，默认 200 | `query` 工具单次最大返回行数 |
| `BIZDB_QUERY_TIMEOUT_SECONDS` | 否，默认 10 | `query` 语句超时 |
| `BIZDB_EXPORT_TIMEOUT_SECONDS` | 否，默认 600 | `export` 语句超时 |
| `BIZDB_EXPORT_MAX_ROWS` | 否，默认 2,000,000 | `export` 硬顶行数，超出直接失败而不是静默截断 |
| `BIZDB_EXPORT_ROW_BATCH_SIZE` | 否，默认 20,000 | Parquet 写入批大小 |

## 接入 Agent（MCP registry 配置示例）

字段对应 `mcp-config-loader.js`/`pi-mcp-adapter-factory.js` 现有 schema，
`command` 方式是 stdio 子进程，最省事：真正的 DSN 只注入到这一个子进程的
env，来自 Agent 自己的 env（走 `secretRef`，不是明文写进配置）。

```json
{
  "id": "bizdb",
  "command": "biz-db-mcp",
  "envRefs": {
    "BIZDB_MYSQL_DSN": "env://BIZDB_MYSQL_DSN",
    "BIZDB_SANDBOX_BASE_URL": "env://BIZDB_SANDBOX_BASE_URL",
    "BIZDB_SANDBOX_API_TOKEN": "env://BIZDB_SANDBOX_API_TOKEN"
  },
  "enabledTools": ["query", "describe_table", "export"]
}
```

如果以后要多个 Agent 实例共享一个 DB 网关，把 `command` 换成 `url`（参考仓库
里已有的 `sandbox-mcp` Streamable HTTP 模式）即可，`biz_db_mcp/server.py`
的 `mcp.run(transport=...)` 只需要切换 transport，工具逻辑不用改。

## 待决问题（骨架里没有替你决定的地方）

1. **`export` 的 session 身份从哪来。** 骨架里 `session_id`/`org_id`/
   `user_id` 是普通工具参数，意味着模型能自己"填"这几个值——生产环境不应该
   信任模型自由生成这几个字段。推荐做法：Agent 在为某个 Run 拉起
   `biz-db-mcp` 子进程时，把该 Run 已知的 `session_id`/`org_id`/`user_id`
   固定注入（例如作为 spawn 时的额外 `args`，或让 MCP 工具从进程级配置读取
   而不是工具参数），模型只需要传 `sql`/`dataset_name`。这个改动点在 Agent
   侧的 MCP 适配层，不在 `biz-db-mcp` 内部逻辑；本骨架先按显式参数实现，
   方便独立测试，正式接入前需要按这一条收紧。
2. **表/字段级权限。** 只读账号是库级别的；如果业务上有些表不该被 Agent
   碰，需要在 `biz-db-mcp` 里加一层表名白名单（`describe_table`/`query`/
   `export` 三个入口统一过滤），骨架里没有实现。
3. **并发与限流。** 骨架没有做「同一 session 同时只能有一个 export 在跑」
   之类的限制；如果担心多个 Run 并发把业务库打满，需要加一个基于
   `session_id`/进程内信号量的限流层。
4. **审计落地。** 骨架把审计日志打到 stderr（JSON 行），够本地调试；生产上
   要接到你们已有的日志/审计管道，或者额外写一张审计表。

## 落地顺序建议

1. 本地直连测试库，跑通 `describe_table`/`query`（不涉及 Sandbox）。
2. 补齐「待决问题」里的 session 身份注入方式，跑通 `export` → Dataset 落地
   → 用真实量级（10 万/100 万行）测一下耗时和 Parquet 文件大小。
3. 接进 Agent 的 MCP registry，端到端跑一遍：模型调用 `export` → `python`
   工具读本地 Dataset → pandas 分析。
