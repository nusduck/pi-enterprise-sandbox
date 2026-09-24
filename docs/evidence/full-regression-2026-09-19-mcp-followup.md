# 2026-09-19 MCP facade 增量证据

本文件记录同日继续执行的 MCP 非 UI 协议探针，承接 [首轮证据](full-regression-2026-09-19-jev-browser.md) 与 [浏览器增量证据](full-regression-2026-09-19-jev-browser-followup.md)。使用真实 `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` 连接本地 `sandbox-mcp` 的 `/mcp`；凭据从运行环境读取，本文不记录 token 或含 token 的 URL。只使用合成 context 和无害内容，没有读取用户私有资料。

## MCP-02：六工具闭环与 Artifact 下载

- `tools/list` 返回且实际调用了恰好六个工具：`sandbox_python_execute`、`sandbox_shell_execute`、`sandbox_file_write`、`sandbox_file_read`、`sandbox_file_list`、`sandbox_artifact_submit`。
- context `jev_mcp_20260919_01` 下执行 `file_write` → `file_read` → `file_list`：文件 `jev-mcp-probe-20260919.txt` 内容为 `MCP_PROBE_20260919` 加换行，大小 19 字节；list 只看到该文件。
- `sandbox_python_execute` 返回 `42`、exit code 0；`sandbox_shell_execute` 返回 `SHELL_PROBE_OK`、exit code 0。
- `sandbox_artifact_submit` 返回 artifact `01M2WTD7XWX2DP5SXNHKHGSH4A`，大小 19 字节，SHA-256 为 `596fbd8b8cdaf8db13fee709d85f3baddfb99bc6a9b3c34f4414d3bdd487278b`。对返回的签名下载地址实际 GET，HTTP 200，下载字节数和 SHA-256 均一致；签名地址未写入本文件。
- 判定：`MCP-02` 合成六工具/快照闭环通过；完整案例仍为 `PARTIAL`，因为没有使用测试设计指定的 W 子集和中文报告，也没有接入外部业务数据。

## MCP-03：context 绑定与边界

- 同 context 的连续操作复用同一工作区并成功提交 Artifact。
- 换用 `jev_mcp_20260919_other` 读取同名文件返回 MCP 工具错误 `Sandbox operation failed`，没有读到原 context 内容。
- 使用含空格的 `bad context` 返回 `Invalid context_id`。
- `/` 返回 HTTP 404；访问 facade 的 `/internal/v1/health` 返回 HTTP 404，未发现从 facade 直达完整内部面的通道。
- 判定：`MCP-03` 为 `PARTIAL`；尚未执行两 context 同名并发、不传 context 后复用服务端返回 ID、过长值、签名篡改和过期验证。

## MCP-04 / MCP-05：仍未关闭的分支

- 正常注册环境可观察到六个工具并可恢复执行，但本次没有注入 MCP 超时/断连，也没有配置可授权的业务只读 MCP，因此 `MCP-04` 的故障恢复、越范围查询和业务数据分支仍为阻塞。
- 本次补充了正常注册、工具目录和 facade 边界证据；无 MCP、禁用 server、启用但连不通、`tools/list_changed`、授权变更和多 server 故障切换仍未执行，因此 `MCP-05` 保持 `PARTIAL`。

## 执行边界

- 未打印凭据、Bearer token 或带 token 的下载 URL。
- 未删除合成文件、context 或 Artifact；清理动作仍需单独确认，CLEAN-01 不受本探针影响。
- 本次没有修改生产代码或测试设计文件。
