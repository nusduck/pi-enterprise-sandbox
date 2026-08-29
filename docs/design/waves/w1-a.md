# W1-A：`contract/` 契约包 ✅

继承 [`_shared.md`](_shared.md)。

## 范围
只改 `contract/`。

## 交付
- `src/envelope.ts` —— RPC 信封，**`workspaceId` 必填**（多实例路由预留键，ADR 0008 D5）；成功/失败泛型包装；运行时 `assertEnvelope`（信封来自网络，类型断言不够）
- `src/errors.ts` —— 复用 DSH 的 `FS_*` 错误码 + 我们的传输层错误码；错误→线上对象的映射**必须脱敏物理路径**
- `src/hmac.ts` —— HS256 + 请求体摘要，**签名算法与现有实现一致**（`tests/fixtures/contracts/agent-sandbox-internal-hmac-hs256-v1.json` 要继续通过）；常量时间比较；**去掉防重放 jti 的 Redis 层**（ADR 0008 D8）；密钥从参数传入，绝不写死或打日志
- `src/index.ts` + 测试

## 参考（只读）
`agent/src/infrastructure/sandbox/internal-hmac.js`、`sandbox/security/internal_auth.py`、`internal_http_auth.py`

## 结果
**29/29 通过**，golden fixture 逐字节相等。

### review 抓到的问题（已修）
`redactPhysicalPaths` 有 **fail-open 缺陷**，且相比 Python 原版掉了四样：
1. 参数给了默认空值 → 忘了传就静默不脱敏（Python 版是由构造 fail-closed 的）
2. 丢了**总是应用**的默认前缀兜底（`/var/sandbox/workspaces` 等）
3. 丢了双 token 折叠（嵌套根会产生 `<workspace><workspace>`）
4. 丢了尾斜杠归一化

修法：参数改**必填**（忘记传是编译错误）；默认前缀做成冻结常量，调用方关不掉。

### agent 处理得好的一点
任务书里"去掉 jti"与"fixture 要继续通过"**存在指令冲突**（fixture 的签名载荷含 jti）。它没有二选一硬猜，而是去读 ADR 原文并核对 Python 两个文件，判定 D8 指的是去掉 Redis replay store 层而非 jti 字段本身。**核实无误。**
