# Design

Agent 服务拥有 Skill Loader；Sandbox 执行环境只读挂载生产 Skill。development 时共享卷可写，但只有 `skill_install/skill_edit/skill_reload` 专用工具获得写 capability。

Git 安装流程：validate URL/ref → clone/fetch 到临时目录 → resolve commit → 验证目录/SKILL.md → 计算摘要 → 原子替换目标 → 写审计 → 标记 loader reload。失败清理临时目录。

回滚切回 readonly 并挂载上一个 Skill 目录快照；已运行 Session 不热替换。

