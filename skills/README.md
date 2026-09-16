# Agent Skills (curated everyday set)

Bundled skill packages are mounted into Agent and Sandbox at
`/home/sandbox/skill` (read-only). User-installed packages live separately
under `/home/sandbox/skill-user/<orgId>/<userId>` — see 三层 Skill below.

The Agent discovers each `*/SKILL.md` package automatically.

## Installed packages (13)

### Create & authoring

| Skill | Purpose | Source |
|-------|---------|--------|
| `skill-creator` | Design and scaffold new Agent Skills | [anthropics/skills](https://github.com/anthropics/skills) |
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
| `baoyu-format-markdown` | Format / clean Markdown | baoyu-skills |
| `baoyu-markdown-to-html` | Markdown → HTML | baoyu-skills |
| `pdf` | PDF creation & manipulation | anthropics/skills |
| `docx` | Word documents | anthropics/skills |
| `pptx` | PowerPoint decks | anthropics/skills |
| `xlsx` | Spreadsheets | anthropics/skills |

### Engineering

| Skill | Purpose | Source |
|-------|---------|--------|
| `mcp-builder` | Build MCP servers/tools | anthropics/skills |
| `planning-and-task-breakdown` | Task planning | addyosmani/agent-skills |

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

## 三层 Skill

| 层 | 路径 | 内容 | 可见范围 | 可写 |
|----|------|------|----------|------|
| 系统 | `/home/sandbox/skill` | 本仓库 `./skills` 自带的 package | 所有人；进 prompt | 否 |
| 草稿 | `/home/sandbox/skill-draft/<orgId>/<userId>` | 模型或上传写入的未启用 package | 仅该用户；**不进 prompt** | 是 |
| 已启用 | `/home/sandbox/skill-user/<orgId>/<userId>` | 人工启用后从草稿复制的发布副本 | 仅该用户；进 prompt | 否 |

每个 Run 只扫描系统层和调用者自己的已启用层，**系统层优先**：同名 package 以系统层为准，
因此启用一个与自带 package 同名的 skill 会被直接拒绝。

已启用目录是 named volume（`agent_user_skills`）下的子目录，所以启用过的 skill：

- **跨对话**：不绑定任何 conversation / session，下次新开对话照样在
- **跨容器重建**：volume 持久化
- **不跨用户**：A 用户启用的 skill 不会出现在 B 用户（哪怕同组织）的 agent 上下文里；
  Sandbox 执行时也只 bind 调用者本人清单里的版本，别人的 package 在沙箱里根本不存在

---

## 用户 Skill 生命周期

`skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` / `skill_list`
已随 ADR 0009 D7 退役。模型侧只剩出厂 `skill`（发现和调用）。闸门只在人按「启用」。

用户有且只有两种新建入口：

1. 在聊天输入框点击 🧩，或 `POST /api/capabilities/skills/drafts` 上传 `.zip` / `.skill`。
   Agent 校验结构后解压到当前用户的草稿根，状态保持未启用。
2. 与 Agent 讨论需求。模型用普通 `write` / `edit` / `bash` 在草稿根里直接造包。

人在 Capabilities 页启用或停用（`POST /api/capabilities/skills/{name}/enable|disable`）。
启用时 Agent 校验并**复制**一份只读发布版本，写入 owner-scoped `user_skill_enablements`。
停用只删账本行，不删草稿或已发布字节。之后改草稿动不了已启用的副本；要发布新内容，先停用再启用。

安全约束：

- ZIP 必须来自当前用户回合，Sandbox 下载仍会校验 session 与 owner。
- 拒绝 Zip Slip、绝对路径、符号链接、特殊文件、加密条目、重复路径和 `.git` 元数据。
- 压缩包、单文件、展开总大小、条目数和路径深度都有硬限制。
- 一个 ZIP 必须只包含一个合法 `SKILL.md` package；系统 Skill 不能被同名覆盖。
- 通用 `write` / `edit` / `bash` 不能写系统根或已启用根；Sandbox 侧这两层只读。
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
