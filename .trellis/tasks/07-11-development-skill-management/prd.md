# 研发 Skill 安装与修改模式

## Goal

保持生产 Skill 只读挂载，同时让单用户研发环境中的普通 Agent 对话可通过专用工具安装和修改共享 Skill。

## Requirements

- `SKILLS_MODE=readonly|development`，默认 readonly；生产使用只读挂载。
- development 模式下专用 Skill 管理工具可写共享目录，后续回合/显式 reload 生效，不要求运行中热替换。
- 首期来源为配置允许的本地目录与 HTTPS Git；Git 必须指定 ref，记录 resolved commit 与目录摘要。
- 禁止 git/SSH、URL 内嵌凭证、任意压缩包 URL、任意安装脚本；npm/OCI 延期。
- 通用 write/edit/bash 不得绕过 Skill 管理入口；名称、路径、SKILL.md 基本格式必须校验。
- development 模式按单用户可信环境处理，不建设 overlay、diff 发布审批或多人冲突。

## Acceptance Criteria

- [ ] 默认/生产模式无法写 Skill，关闭外部能力时不访问网络。
- [ ] development 对话可安装本地/HTTPS Git Skill、修改并在下一回合 reload。
- [ ] 非允许来源、非法 ref、路径逃逸、凭证 URL 和缺失 SKILL.md 被拒绝。
- [ ] 安装失败不破坏已有 Skill，使用临时目录与原子替换。
- [ ] 变更记录 actor、source/ref/resolved commit、摘要、结果和 trace。

