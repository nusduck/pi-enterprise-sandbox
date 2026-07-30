# Agent Skills (curated everyday set)

Bundled skill packages are mounted into Agent and Sandbox at
`/home/sandbox/skill` (read-only). User-installed packages live separately
under `/home/sandbox/skill-user/<orgId>/<userId>` — see 两层 Skill below.

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
- This directory is the **system tier**: bundled with the image and read-only in
  every mode. User installs land in a separate per-user tier.

---

## 两层 Skill

| 层 | 路径 | 内容 | 可见范围 | 可写 |
|----|------|------|----------|------|
| 系统 | `/home/sandbox/skill` | 本仓库 `./skills` 自带的 package | 所有人 | 否（任何模式） |
| 用户 | `/home/sandbox/skill-user/<orgId>/<userId>` | 该用户 `skill_install` 装的 package | **仅该用户本人** | 是 |

每个 Run 扫描 `[系统层, 自己的用户目录]`，**系统层优先**：同名 package 以系统层为准，
因此装一个与自带 package 同名的 skill 会被直接拒绝（否则装了也不会生效）。

用户目录是一个 named volume（`agent_user_skills`）下的子目录，所以装过的 skill：

- **跨对话**：不绑定任何 conversation / session，下次新开对话照样在
- **跨容器重建**：volume 持久化
- **不跨用户**：A 用户装的 skill 不会出现在 B 用户（哪怕同组织）的 agent 上下文里；
  Sandbox 执行时也只 bind 调用者本人的目录，别人的 package 在沙箱里根本不存在

---

## 安装 Skill

### 1. 默认就能装

**不需要开发模式**。`SKILLS_MODE` 默认 `enabled`，生产环境同样可用。安全性来自两点：

1. 写入范围被限制在调用者自己的 `<orgId>/<userId>` 目录
2. `skill_install` 在风险表里是 `high`，走审批

要彻底关掉安装能力：`SKILLS_MODE=readonly`（skill 生命周期工具不再注册）。

可选配置：

```bash
# .env
# 允许 skill_install 从这些容器内绝对路径拷贝（git 源不需要）
SKILLS_INSTALL_LOCAL_ALLOWLIST=/tmp/skill-src
# 可选审计
# SKILLS_AUDIT_LOG=/tmp/skill-audit.jsonl
```

工具：`skill_list` / `skill_install` / `skill_uninstall` / `skill_edit` / `skill_reload`。

### 2. 安装体验

`skill_install` **只需要 `source`**：

- 源类型自动判断（`https://…` → git；其它 → 本地路径）
- git ref 默认 `HEAD`
- 包目录自动发现：SKILL.md 在仓库根或 `skills/<name>/` 都能找到，找到多个会报错
  并列出候选让你用 `subpath` 指定
- package 名取自 SKILL.md 的 `name`，不用重复写；写了就必须一致
- 装完自动 `skill_reload`，当前回合即可使用

对话里直接说即可：

```
装一下 https://github.com/anthropics/skills 里的 skill-creator
```

Agent 会调用：

```
skill_install:
- source: https://github.com/anthropics/skills
- subpath: skills/skill-creator     # 仓库里有多个 package 时才需要
```

本地目录：

```
skill_install:
- source: /tmp/skill-src/my-skill   # 必须在 SKILLS_INSTALL_LOCAL_ALLOWLIST 下
```

内容相同的重复安装是显式 no-op（返回 `idempotent: true`），不会反复覆盖。
`skill_uninstall` 只能删自己装的 package。

### 3. 审批

Skill 工具和其它工具一样走风险表（`config/agent/tool-risk.json`）。默认：

| 工具 | 风险 | 结果 |
|------|------|------|
| `skill_list` / `skill_reload` | low | 直接放行 |
| `skill_edit` | medium | 直接放行 |
| `skill_install` / `skill_uninstall` | high | 需要审批 |

安装意味着下一回合会执行第三方代码，所以默认要审批。要免审批就把
`tool-risk.json` 里 `skill_install` 调成 `low`/`medium`。

### 4. 约束（安全）

- **拒绝**：`git@` / SSH、URL 内凭证、npm/OCI、任意压缩包脚本
- 通用 `write` / `edit` / `bash` **不能**写任何 skill 根；只有 `skill_install` /
  `skill_edit` / `skill_uninstall` 可以，且只能写调用者自己的目录
- 系统层在所有模式下只读，安装无法覆盖自带 package
- Sandbox 侧两层 skill 都是**只读**挂载（执行用），且只 bind 调用者本人的用户目录
- orgId / userId 作为路径段会被严格校验，无法用 `../` 逃逸

### 5. 校验格式

每个 package：

```
my-skill/
  SKILL.md          # --- name: my-skill\ndescription: ...\n---\n body
  scripts/          # 可选
```

`name` 必须匹配 `/^[a-z0-9][a-z0-9_-]{0,63}$/`，并与目录名一致。
