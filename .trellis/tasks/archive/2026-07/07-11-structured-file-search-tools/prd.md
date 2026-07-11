# 结构化 ls/find/grep 工具

## Goal

在 Sandbox 提供结构化、受限、可审计的文件发现与文本检索，替代 SDK 本地工具和不必要的通用 Bash。

## Requirements

- 工具只访问当前 workspace；不访问 Skill、系统目录、密钥或其他 Session。
- `ls(path='.', depth=1, include_hidden=false)`；最多 1,000 项、深度 5。
- `find(path='.', pattern, type?, max_depth?, limit?)`；默认深度 20、最多 500 项。
- `grep(path='.', query, glob?, regex=false, case_sensitive=true, context?, limit?)`；默认普通文本，显式 regex 才启用受限正则。
- grep 最多 500 matches、context 每侧 5 行、单文件 5 MB、总扫描 100 MB、超时 5 秒。
- 调用方只能收紧限制；返回结构化 JSON、相对路径、skipped、统计和 truncated reason。
- 不跟随逃逸 symlink；跳过二进制/大文件；所有调用进入 Extension 与 Sandbox 审计。
- 覆盖/禁用 SDK 内置本地 ls/find/grep，确保实际执行只在 Sandbox。

## Acceptance Criteria

- [ ] 正常/空/隐藏/二进制/大文件/symlink/截断/超时/正则复杂度测试通过。
- [ ] 结果顺序稳定，路径不泄露物理根。
- [ ] Agent 工具 schema 与 Sandbox 响应共享版本化契约。
- [ ] 禁用 Bash 后仍可完成基础文件发现与检索。

