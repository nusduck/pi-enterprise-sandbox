# Agent Skills (curated everyday set)

Bundled skill packages are mounted into Agent and Sandbox at
`/home/sandbox/skill` (read-only). User-installed packages live separately
under `/home/sandbox/skill-user/<orgId>/<userId>` — see 两层 Skill below.

The Agent discovers each `*/SKILL.md` package automatically.

## Installed packages (21)

### Create & authoring

| Skill | Purpose | Source |
|-------|---------|--------|
| `skill-creator` | Design and scaffold new Agent Skills | [anthropics/skills](https://github.com/anthropics/skills) |
| `doc-coauthoring` | Collaborative document drafting | anthropics/skills |
| `theme-factory` | Theme / visual system generation | anthropics/skills |

### Skill quality & learning

| Skill | Purpose | Source |
|-------|---------|--------|
| `skill-vetter` | Security-first vetting for external skills | [dtyq/magic](https://github.com/dtyq/magic/tree/master/backend/super-magic/agents/skills/skill-vetter) |
| `grill-me` | Stress-test plans and designs through guided questioning | [grp06/useful-codex-skills](https://github.com/grp06/useful-codex-skills/tree/main/grill-me) |

### Documents & conversion

| Skill | Purpose | Source |
|-------|---------|--------|
| `convert-to-markdown` | General PDF/DOCX/HTML/URL → Markdown | local curated |
| `baoyu-url-to-markdown` | Fetch URL → Markdown | [jimliu/baoyu-skills](https://github.com/jimliu/baoyu-skills) |
| `baoyu-format-markdown` | Format / clean Markdown | baoyu-skills |
| `baoyu-markdown-to-html` | Markdown → HTML | baoyu-skills |
| `baoyu-translate` | Translate content | baoyu-skills |
| `pdf` | PDF creation & manipulation | anthropics/skills |
| `docx` | Word documents | anthropics/skills |
| `pptx` | PowerPoint decks | anthropics/skills |
| `xlsx` | Spreadsheets | anthropics/skills |

### Engineering

| Skill | Purpose | Source |
|-------|---------|--------|
| `frontend-design` | UI / frontend craft | anthropics/skills |
| `webapp-testing` | Web app testing patterns | anthropics/skills |
| `mcp-builder` | Build MCP servers/tools | anthropics/skills |
| `code-review-and-quality` | Code review checklist | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) |
| `debugging-and-error-recovery` | Debugging playbook | addyosmani/agent-skills |
| `planning-and-task-breakdown` | Task planning | addyosmani/agent-skills |
| `documentation-and-adrs` | Docs & ADRs | addyosmani/agent-skills |

## Usage

In chat, name the skill or describe the task, e.g.:

- “用 skill-creator 帮我做一个部署 skill”
- “把这个 PDF 转成 markdown”
- “review 这段代码”

## Notes

- Upstream licenses remain those of the source repos (see each package).
- This directory is the **system tier**: bundled with the image and always
  read-only. User installs land in a separate per-user tier.

---

## 两层 Skill

| 层 | 路径 | 内容 | 可见范围 | 可写 |
|----|------|------|----------|------|
| 系统 | `/home/sandbox/skill` | 本仓库 `./skills` 自带的 package | 所有人 | 否 |
| 用户 | `/home/sandbox/skill-user/<orgId>/<userId>` | 该用户 `skill_install` 装的 package | **仅该用户本人** | 是 |

每个 Run 扫描 `[系统层, 自己的用户目录]`，**系统层优先**：同名 package 以系统层为准，
因此装一个与自带 package 同名的 skill 会被直接拒绝（否则装了也不会生效）。

用户目录是一个 named volume（`agent_user_skills`）下的子目录，所以装过的 skill：

- **跨对话**：不绑定任何 conversation / session，下次新开对话照样在
- **跨容器重建**：volume 持久化
- **不跨用户**：A 用户装的 skill 不会出现在 B 用户（哪怕同组织）的 agent 上下文里；
  Sandbox 执行时也只 bind 调用者本人的目录，别人的 package 在沙箱里根本不存在

---

## 用户 Skill 生命周期

Skill 生命周期不区分开发环境和生产环境。用户有且只有两种新建入口：

1. 在聊天输入框点击 🧩，上传一个 `.zip`，然后发送安装请求。Agent 使用当前回合的
   `attachment_id` 调用 `skill_install`；URL 和文件系统路径不会被接受。
2. 与 Agent 讨论需求。内容确认后，Agent 用完整的说明和可选文本文件调用
   `skill_create`，一次性生成并安装 package。

已有用户 Skill 可以通过 `skill_edit` 修改、通过 `skill_uninstall` 删除。所有变更完成后
都会自动刷新运行时能力清单；内容相同的重复安装是显式 no-op。

工具与审批策略：

| 工具 | 风险 | 结果 |
|------|------|------|
| `skill_list` | low | 直接放行 |
| `skill_install` | high | 审批后下载、解压并安装当前回合 ZIP |
| `skill_create` | high | 审批后原子写入 Agent 生成的 package |
| `skill_edit` / `skill_uninstall` | high | 审批后修改或删除 |

附件上传会先形成 Dataset；安装审批发生在 Agent 读取、解压和写入 Skill 目录之前。
拒绝审批不会改变用户 Skill 目录；批准后只执行持久化工具调用中已经确认的参数。

安全约束：

- ZIP 必须来自当前用户回合，Sandbox 下载仍会校验 session 与 owner。
- 拒绝 Zip Slip、绝对路径、符号链接、特殊文件、加密条目、重复路径和 `.git` 元数据。
- 压缩包、单文件、展开总大小、条目数和路径深度都有硬限制。
- 一个 ZIP 必须只包含一个合法 `SKILL.md` package；系统 Skill 不能被同名覆盖。
- `skill_edit` 只能修改已安装 package，不能绕过审批创建新 Skill。
- 通用 `write` / `edit` / `bash` 不能写 Skill 根；Sandbox 侧 Skill 挂载只读。
- orgId / userId 路径段严格校验，不同用户的目录互不可见。

可选审计配置：

```bash
# SKILLS_AUDIT_LOG=/tmp/skill-audit.jsonl
```

### Package 格式

每个 package：

```
my-skill/
  SKILL.md          # --- name: my-skill\ndescription: ...\n---\n body
  scripts/          # 可选
```

`name` 必须匹配 `/^[a-z0-9][a-z0-9_-]{0,63}$/`，并与目录名一致。
