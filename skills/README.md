# Agent Skills (curated everyday set)

Shared skill packages mounted into Agent / Sandbox at:

- `/home/sandbox/skill`
- `/sandbox/skills`
- `/app/.pi/skills`

The Agent discovers each `*/SKILL.md` package automatically.

## Installed packages (19)

### Create & authoring

| Skill | Purpose | Source |
|-------|---------|--------|
| `skill-creator` | Design and scaffold new Agent Skills | [anthropics/skills](https://github.com/anthropics/skills) |
| `doc-coauthoring` | Collaborative document drafting | anthropics/skills |
| `theme-factory` | Theme / visual system generation | anthropics/skills |

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
- Production default is `SKILLS_MODE=readonly` (skills readable/executable, not installable).
- Development install/edit: set `SKILLS_MODE=development` and a writable `AGENT_SKILLS_MOUNT` (see below).

---

## 研发模式：如何给 Agent 安装 Skill

### 1. 打开 development 模式

编辑仓库根目录 `.env`：

```bash
SKILLS_MODE=development
# 可写挂载：宿主机 ./skills → 容器 /home/sandbox/skill
AGENT_SKILLS_MOUNT=./skills:/home/sandbox/skill:rw
# 可选：允许 skill_install 从白名单本地路径拷贝
SKILLS_INSTALL_LOCAL_ALLOWLIST=/tmp/skill-src
# 可选审计
# SKILLS_AUDIT_LOG=/tmp/skill-audit.jsonl
```

然后重启 agent（skill 卷变更需要 recreate）：

```bash
docker compose up -d agent
# 或本地进程：
# SKILLS_MODE=development npm run dev --prefix agent
```

### 2. 三种安装方式

| 方式 | 做法 | 何时用 |
|------|------|--------|
| **A. 手工放入** | 在 `skills/<name>/` 放 `SKILL.md`（frontmatter 必须有 `name` + `description`，且 `name` = 目录名） | 从别处拷贝现成 package |
| **B. 对话安装** | 对 Agent 说「安装 skill…」→ 走 `skill_install`（本地白名单路径或 HTTPS Git + ref） | 研发对话里热装 |
| **C. Git 安装（工具）** | Agent 调用 `skill_install`：`source_type=git`，`source=https://…`，**必须带 ref**（branch/tag/sha） | 从 GitHub 拉官方 skill |

示例（对话里让 Agent 执行的语义）：

```
请 skill_install：
- name: skill-creator
- source_type: git
- source: https://github.com/anthropics/skills
- ref: main
- subpath: skills/skill-creator
```

本地目录：

```
请 skill_install：
- name: my-skill
- source_type: local
- source: /tmp/skill-src/my-skill   # 必须在 SKILLS_INSTALL_LOCAL_ALLOWLIST 下
```

装完后可用 `skill_reload` 立即重新扫描；下一回合通常也会自动扫。

### 3. 约束（安全）

- **拒绝**：`git@` / SSH、URL 内凭证、npm/OCI、任意压缩包脚本
- 通用 `write` / `edit` / `bash` **不能**写 skill 根；只有 `skill_install` / `skill_edit` 可以
- Sandbox 侧 skill 挂载始终 **只读**（执行用）；写入只在 Agent 可写卷
- 生产 / `docker-compose.prod.yml` 强制 `readonly` + `:ro`

### 4. 校验格式

每个 package：

```
skills/my-skill/
  SKILL.md          # --- name: my-skill\ndescription: ...\n---\n body
  scripts/          # 可选
```

`name` 必须匹配 `/^[a-z0-9][a-z0-9_-]{0,63}$/`，并与目录名一致。
