# 2026-09-19 MCP context / 签名边界增量证据

本文件只追加本轮对 MCP-03 的安全边界探针，不改写同日其它证据。使用真实 `StreamableHTTPClientTransport`，全部是新建合成 context 和短文本；未记录凭据或下载 token。

## MCP-03

- 两个 context `jev_mcp_same_name_a_20260919` / `jev_mcp_same_name_b_20260919` 并发写入同名 `same-name.txt`，随后分别读取，A 得到 `CONTEXT_A`，B 得到 `CONTEXT_B`；证明同名路径按 context 隔离。
- 省略 `context_id` 写入 `generated-context.txt`，响应返回服务端生成的 context ID；用该 ID 读取得到 `GENERATED_CONTEXT_OK`。
- 256 字符 context ID 被拒，工具结果为 `Invalid context_id`。
- 对有效 Artifact 下载地址实际 GET 返回 200、10 字节；仅改动签名最后一字符后 GET 返回 404，篡改被拒绝。
- 过期签名未在共享环境中等待或篡改运行时钟，因此仍未宣称过期分支通过。

## 状态

`MCP-03` 由部分通过证据进一步收敛：同 context、跨 context 隔离、并发同名、自动生成 ID、过长/非法 ID、有效下载和签名篡改均有实测；过期下载及其余部署/凭据生命周期分支仍未执行。

## 边界

- 没有删除合成文件、context 或 Artifact。
- 没有修改生产代码或测试设计文件。
