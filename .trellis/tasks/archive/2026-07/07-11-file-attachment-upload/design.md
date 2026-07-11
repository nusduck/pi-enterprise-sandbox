# Design

## Flow

`select → ensure conversation/session → create attachment draft → streaming upload → uploaded → submit user turn with attachment IDs`。

附件存储为 `uploads/{attachment_id}/{sanitized_name}`；数据库保存 owner、conversation/workspace、原名、逻辑路径、MIME、大小、hash、状态、幂等键和 TTL。发送使用事务将 draft 绑定到 user message；Agent 接收可信附件 manifest。

## Error Contract

使用稳定业务码：`attachment_type_denied`、`attachment_too_large`、`turn_attachment_limit`、`workspace_quota_exceeded`、`upload_cancelled`、`upload_incomplete`。大小/总量超限为 413；权限为 404/403；可重试传输错误不删除草稿。

## Migration and Rollback

新增附件 API 与 UI 状态，不复用旧自动发送路径。切换前可保留旧上传端点只读兼容；回滚 UI 时附件记录和隔离文件仍可通过文件 API读取，禁止回滚到同名覆盖写入。

