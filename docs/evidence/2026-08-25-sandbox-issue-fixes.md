# 2026-08-25 真机验证：sandbox 问题清单修复

分支 `fix/2026-08-25-sandbox-issues`（`5e2c6e71`、`33a989f5`、`ff070a62` 及后续）。
`docker compose build agent sandbox && docker compose up -d agent agent-worker sandbox`
后在真实栈上执行，非单测。排查与根因见
[`../reviews/2026-08-25-sandbox-issue-triage/`](../reviews/2026-08-25-sandbox-issue-triage/)。

镜像：`enterprise-sandbox:latest` = `sha256:f5471034…`，`pi-enterprise-agent:latest` = `sha256:444ee91d…`。

## 链路：登录 → 建会话 → 带工具的 Run

新注册用户 → `POST /api/conversations` → `POST /api/conversations/{id}/runs`。

### 问题二：中文文件名（Run `01M0WMW3CFVQH8ATHRC4HBW3CT`，SUCCEEDED）

```
write : succeeded  {"ok":true,"path":"/home/sandbox/workspace/专项汇报.md","bytesWritten":12,…}
bash  : succeeded  {"exitCode":0,"stdout":"/home/sandbox/workspace\n"}
read  : succeeded  {"path":"/home/sandbox/workspace/专项汇报.md","content":"1|验证通过",…}
```

修复前该 `write` 在 Agent 本地校验阶段就失败（`FILES_WRITE_PAYLOAD_INVALID:
path must be bounded visible ASCII`，`fetchCalls: 0`），请求根本到不了 Sandbox。

### 问题七：装完 Skill 后 bash / python 仍然可用

**先在真实卷上复现旧行为**（按旧代码那句 `mkdir(..., {recursive:true, mode:0o700})`）：

```
0755 /home/sandbox/skill-user
0700 /home/sandbox/skill-user/<org>
0700 /home/sandbox/skill-user/<org>/<user>
```

以 Sandbox 的 uid 10001 访问该 bind source，并跑 bwrap：

```
stat: cannot statx '…/<org>/<user>': Permission denied
bwrap: Can't find source path /home/sandbox/skill-user/<org>/<user>: Permission denied
```

—— 与用户截图同一条错误，且 errno 明确是 `Permission denied`，证实
`--ro-bind-try` 只宽容 `ENOENT`。

**Sandbox 侧纵深防御**（保持上面那个坏掉的目录不变，用新代码组装 launch）：

```
[WARNING] User skill root is not readable; continuing with the system tier only: …
user-skill binds emitted: NONE (degraded to system tier)
bash still runs: /home/sandbox/workspace
```

**Agent 侧修复 + 自愈**（不先删除，直接在坏掉的目录上安装）：

```
before: 700 <org>   700 <org>/<user>
after : 755 /home/sandbox/skill-user   755 <org>   755 <org>/<user>   755 <org>/<user>/verify-skill
```

同一个 bind 再跑 bwrap：

```
755 /home/sandbox/skill-user/<org>/<user>
/            ← pwd
---          ← head -2 …/verify-skill/SKILL.md
name: verify-skill
```

**端到端**：给真实用户装一个 Skill 后发起 Run `01M0WMYXMGZQ89KYSW3W61CPYY`（SUCCEEDED）：

```
bash   : succeeded  {"exitCode":0,"stdout":"/home/sandbox/workspace\n"}
python : succeeded  {"exitCode":0,"stdout":"2\n"}
```

### 问题六：`~/.config` 在 Session 内保留

用 Sandbox 容器里的生产 `prepare()` 生成 argv，跑真实 bwrap：

```
run 1 (write profile)     : WROTE
run 2 (fresh execution)   : PERSISTED:macro
run 3 (XDG env honoured)  : /home/sandbox/.config → libreoffice
run 4 (workspace + /tmp)  : RW_OK
```

修复前同样两步得到 `WROTE` / `GONE`。

### 问题四：三层口径一致

Run `01M0WN00FENHYDSTY5QSZSRNDJ`，模型对 Skill 根调用 `ls`：

```
Error [PATH_SKILL_SEARCH_UNSUPPORTED]: Skill directories are not searchable. …
```

不再把注定被 Sandbox 拒绝的路径发出去。

**Skill 的正常使用路径**（Run `01M0WN5N578M3ZKMA2K2K2V3HX`，新会话，SUCCEEDED）：
模型从 skills 段拿到 location，直接 `read` 到位——

```
read: /home/sandbox/skill-user/<org>/<user>/verify-skill/SKILL.md
```

证明用户层 bind 生效、`read` 可达、location 正确。

> 注意一个验证过程中的陷阱：在**已有会话中途**用生产代码直接装 Skill（绕过
> skill-lifecycle 的 reload）时，模型拿不到新 skill 的 location，会去猜路径并得到
> `FILE_NOT_FOUND`。这不是缺陷，是验证方法绕过了 reload；换新会话即正确。

## 未在本次真机验证覆盖

- 问题一（A2A 流式）：需要签发 A2A 凭据，本次未做；已有单元级复现与回归测试。
- 问题三（刷新丢正文）：前端行为，由 `frontend/test/rehydrate-active-run-messages.test.ts` 覆盖。

## 清理

验证用的 Skill 包与 `<org>/<user>` 目录已从 `agent_user_skills` 卷删除
（`skill-user entries: 0`）；容器内临时脚本已删除；测试账号与其会话保留在库中。

---

## 追加：图片分析 `Out of sort memory`（同日报告，真机复现 + 修复验证）

### 复现（真实栈）

让模型生成 1.5MB PNG 后，用 vision 模型 `deepseek-v4-flash-vision-exp` 触发 `read` 内联：

```
run 01M0WP2AGEBEE1YQ0162GJZEK7  FAILED
reason: select * from `messages` where `agent_session_id` = … order by `sequence_no` asc limit 500
        - Out of sort memory…
```

与用户报告逐字一致。用默认（非 vision）模型跑同一个 `read` 不会失败——返回
`[Current model does not support images. The image will be omitted…]`，这解释了为何
只有图片分析触发。

### 执行计划

```
key: idx_messages_session_pi_kind    Extra: Using index condition; Using where; Using filesort
```

该索引中间列是 `pi_entry_kind`，而查询过滤 `message_type`，故无法提供 `sequence_no`
顺序 → filesort → 对整行（含 `content_json`）排序。`sort_buffer_size` 默认 262144。

### 两个容易带偏排查的现象

1. **事后查库看不到大行**：失败回滚，2.7MB 那条 entry 随之消失。复现后立即查，journal
   最大行只剩 2.9KB，同一条 SQL 还能正常返回 12 行。
2. **会话没有被永久损坏**：失败后再发一轮普通 bash，`SUCCEEDED`
   （run `01M0WP67TEEAYP22P8T362YMHJ`）。是「每次图片分析都失败」，不是「对话报废」。

### 修复后 A/B（同一份真实数据，session `01M0WNZWV0YAJP00Y4JE5A03SH`，含一条 2.015MB entry）

```
--- OLD query (no hint) ---     ERROR 1038 (HY001): Out of sort memory…
--- NEW query (FORCE INDEX) --- COUNT(*) = 22
```

### 端到端

重建 agent 镜像后重跑此前失败的那轮图片分析：

```
run 01M0WQ0ZM20KPQD0FSFQQ6GFK8  SUCCEEDED
journal: pi_journal_entry  n=21  max_mb=2.015
```

2MB 的 entry 确实落库，Run 正常完成。

### 未做

`JOURNAL_DEFAULT_PAGE_SIZE` 仍是按行数（500）分页，没有字节预算——排序问题解决了，但
500 × 2.7MB 一次性拉进 Node 仍是隐患。已记入 `review-deferred-items.md`。
