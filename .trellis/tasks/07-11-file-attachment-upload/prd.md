# 文件附件输入与上传修复

## Goal

修复上传内部错误，将文件作为可编辑、可移除、可重试的附件草稿，并在用户点击发送时与文本组成同一用户回合。

## Confirmed Evidence

- `frontend/src/main.js:480-507` 要求先有 Session，上传成功后自动写入提示并发送。
- `api-server/server.js` 使用 `readBodyBuffer()` 缓冲完整 multipart；`sandbox/routers/files.py` 又将 chunks 拼接为完整 bytes。
- 当前原文件名直接作为 workspace 路径，同名会覆盖；超限返回 400 而非统一 413。

## Requirements

- 选择文件后创建/复用 Conversation 与 Sandbox Session，立即后台上传但不发消息。
- 附件状态为 queued/uploading/uploaded/failed/removed；失败保留文本和草稿，可重试。
- 点击发送时只提交全部已上传附件；上传中/失败时阻止不完整发送。
- 每个附件有不可变 ID、隔离路径和上传幂等键；同名不覆盖，主动重复选择不去重。
- 默认最多 10 个、单文件 50 MB、单回合 200 MB、workspace 500 MB；超限返回 413。
- 白名单与受限压缩格式遵循父任务 P-00F1；解压不是上传隐式动作。
- 用户回合保存原始文本与系统附件清单；Agent 获得逻辑相对路径并按需读取。
- 发送前移除会清理草稿；发送后取消不撤回消息/附件。

## Acceptance Criteria

- [ ] 选择文件不自动发送，支持文本编辑、移除、多附件、同名与重试。
- [ ] BFF 和 Sandbox 全程流式处理，不把完整上传保存在内存。
- [ ] 前端/BFF/Sandbox 分层校验上限和白名单，服务端错误码稳定。
- [ ] 同一幂等键重试只生成一个附件；同名独立附件均可被 Agent 读取。
- [ ] 上传、取消、断线、超限、配额、白名单、压缩包和 TTL 清理有自动化测试。
- [ ] 通过 trace_id 可串联浏览器、BFF、Sandbox 错误。

