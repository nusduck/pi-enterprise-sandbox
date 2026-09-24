# 内部 HMAC 实现收口到 `@pi/contract` 的验证（2026-09-04）

**Location:** `docs/evidence/`（带日期的验收证据，不是进度看板）。
**验收状态:** 见 [`../STATUS.md`](../STATUS.md)。本次**没有**关闭任何 §32 行。

## 起因

`agent/src/infrastructure/sandbox/internal-hmac.ts`（980 行）与
`contract/src/hmac.ts`（816 行）实现的是同一份 `agent-sandbox-internal-hmac-hs256-v1`
契约，长期并存；`internal-session-http.ts` 与 `internal-artifact-download-http.ts`
两个生产模块仍在用 agent 那份。exec 与 `runtime/providers/exec-rpc.ts` 用的是 contract 那份。

## 先证明两份不等价，再补齐——不靠放宽来"统一"

把 agent 那套 599 行严格性套件原样指向 `@pi/contract/hmac.js`，**21 条里 2 条失败**：

| 输入 | agent 实现 | contract 实现（收口前） |
|------|-----------|------------------------|
| keyring 的值是 getter（accessor 属性） | `INTERNAL_TOKEN_KEYRING_INVALID` | **ACCEPTED** |
| `scope` 数组挂了额外自有属性（`['x']` + `.extra`） | `INTERNAL_TOKEN_CLAIM_INVALID` | **ACCEPTED** |

其余 19 条（含跨语言 golden fixture 的确定性签发/验证与两条负向向量）本来就一致。

两条都补进 `contract/src/hmac.ts` 之后重跑：**21/21 PASS**。

- getter 之所以必须拒：它能在"校验"与"取用"之间返回不同的字节（校验一份、
  签名另一份），并且会在校验期间执行任意代码——密钥来源不能是一段可执行逻辑。
- `scope` 之所以要连自有属性一起算：`['x']` 上再挂一个 `.extra` 仍然 `length === 1`，
  但它已经不是那个被约束住的一元 scope。

## 收口动作

- 两个生产模块改从 `@pi/contract/hmac.js` 取签名实现。
- `normalizeBaseUrl` 与签名无关（它管的是"这个地址能不能拿来发内部请求"），
  抽到 `agent/src/infrastructure/sandbox/transport-base-url.ts`，65 行，
  自带 `SandboxTransportConfigError`（原先借用 `InternalHmacError` 携带一个不在
  其错误码枚举里的 `SANDBOX_TRANSPORT_CONFIG`）。
- 删除 `agent/src/infrastructure/sandbox/internal-hmac.ts`（980 行）。
- 599 行严格性套件随实现移到 `contract/test/hmac-strict.test.ts`——contract 自己的
  CI job 从此覆盖它。contract 测试数 29 → 50，agent 1240 → 1219。
- `no-authoritative-run-map.unit.test.js` 的 Map 白名单 28 → 27（那条正是
  被删文件里的 keyring 解码 Map），已在断言旁注明原因。

## 生产镜像内验证（重建后 `docker compose exec agent`）

```
transport constructed, methods: downloadArtifact
credentials rejected: SANDBOX_TRANSPORT_CONFIG      # baseUrl 带凭据
31-byte key      : INTERNAL_TOKEN_KEYRING_INVALID
padded base64    : INTERNAL_TOKEN_BASE64URL_INVALID
getter keyring   : INTERNAL_TOKEN_KEYRING_INVALID   # ← 收口前 contract 会放行
good keyring     : ACCEPTED
```

## 真实链路（重建四个镜像后）

与 `exec-durable-artifacts-and-hardening-2026-09-04.md` 同一套脚本，**15/15 PASS**。

其中 `internal-session-http.ts`（本次改动的两个消费者之一）确实在链路上：
两轮 run 期间 sandbox 侧记录到两次

```
exec POST /internal/v1/sessions/ensure 200
```

即"用 contract 实现签发的令牌，被 exec 的验证器接受"。

## 六套单测 + 类型检查

```
uv run pytest -q                    100 passed
npm test --prefix contract           50 pass / 0 fail   （29 → 50，套件迁入）
npm test --prefix exec              337 pass / 0 fail / 1 skipped
npm test --prefix api-server        154 pass / 0 fail
npm test --prefix agent            1219 pass / 0 fail   （1240 → 1219，套件迁出）
npm test --prefix frontend          350 pass / 0 fail
```

类型检查：`exec` / `contract` / `api-server` / `agent`（主程序 + runtime strict）/
`frontend` 全部通过。

## 未做

`agent/src/runtime/providers/exec-rpc.ts` 里还有一个**同名但不同语义**的私有
`normalizeBaseUrl`：它只去掉结尾斜杠，没有凭据/query/scheme 策略。两者不是重复实现，
故意没有合并——exec-rpc 的 baseUrl 来自进程环境而不是用户输入。要不要把它也收到
同一条策略下，是单独一件事。
