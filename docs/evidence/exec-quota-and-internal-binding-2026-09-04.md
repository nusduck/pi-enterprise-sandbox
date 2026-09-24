# 配额落库与内部面绑定收紧（2026-09-04 晚）

**Location:** `docs/evidence/`（带日期的验收证据，不是进度看板）。
**验收状态:** 见 [`../STATUS.md`](../STATUS.md)。本次**没有**关闭任何 §32 行。

与 [`exec-durable-artifacts-and-hardening-2026-09-04.md`](exec-durable-artifacts-and-hardening-2026-09-04.md)
同一天、同一套栈、同一套链路脚本的后续批次。


（同一天的后续批次，与上文同一套栈、同一套脚本。）

### 配额确实读的是 MySQL

往 `workspace_quota_reservations` 直接插一条 1 GiB 的预留，再让 exec 提交一个
7 字节的产物：

```
mysql> INSERT INTO workspace_quota_reservations (workspace_id, reservation_id, bytes)
    -> VALUES ('01M1P8K4FZ3YR9AYWAWSG6BWZT','probe-fill', 1073741824);

$ # 经 agent 容器调 /internal/v1/artifacts/submit
REJECTED: Workspace quota exceeded: usage 7 + reserved 1073741824 + request 7
          = 1073741838 bytes, quota 1073741824 bytes
```

修复前那条 `reserved` 恒为 0——预留记在进程内的 Map 里，重启即忘，而且产物与
数据集各有一份、互相看不见。

### 内部面绑定

`htm` / `scope` / `tool_name` 三项现在逐字绑定路由（表在
`@pi/contract` 的 `internalBindingForHtu()`）。离线用例见
`exec/test/http-internal.test.ts` 的「内部面：方法与能力都必须逐字绑定」一组：
POST 令牌打 GET 端点、文件 scope 打 shell 端点、scope 对但 tool_name 冒充、
未登记路径——四条全部拒。

**过程中自己引入又抓住的一个 bug**：给 `issueToken` 加 method 参数时，`post()`
与 `getStream()` 两处调用签反了，POST 请求带着 `htm: 'GET'` 的令牌，真实链路上
exec 全线 401 `htm mismatch`。单测当时没抓住——假 fetch 不校验 HMAC。已补
`remote-providers.test.ts` 里一条解开令牌、比对 htm/htu/scope/tool_name 与真实
请求的用例；把两处再签反一次，这条立刻失败。这也是"只跑单测不算完成"的又一个
现成例子。

### 真实链路与门禁（本批次改动后重跑）

- §4 真实链路：**15/15 PASS**
- G7 孤儿回收门禁：**8/8 PASS**
