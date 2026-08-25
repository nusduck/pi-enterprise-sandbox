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
