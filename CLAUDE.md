@AGENTS.md

<!--
本仓库的工作规范只有一份，写在 AGENTS.md（其他 coding agent 也读它）。
Claude Code 不读 AGENTS.md，只读 CLAUDE.md，所以这里用 @ 把它导入进来。
新规则请加到 AGENTS.md；只有「仅对 Claude Code 生效」的内容才写在下面。
-->

## Claude Code 专属

- 本仓库文档与 commit message 用中文，代码注释跟随所在文件的既有语言。
- 触及 `agent/`、`api-server/`、`exec/` 运行路径或删除生产代码时，按 AGENTS.md §4
  重建容器跑真实链路；只跑单测算未完成。
- 提交用显式路径（AGENTS.md §7 最后一条），不要 `git add -A`。
