# 2026-08-26 真机验证：`skill_install(source:"sandbox")` 的下载段与 digest 绑定

分支 `feat/skill-ls-and-install-digest`。在**运行中的真实栈**上执行，非单测：
Agent 源码挂进 `pi-enterprise-agent:latest` 容器，对 `pi-enterprise-sandbox`
的真实 HTTP 面发起请求。

脚本：[`2026-08-26-verify-sandbox-install.mjs`](./2026-08-26-verify-sandbox-install.mjs)

```
docker compose run --rm --no-deps \
  -e VERIFY_ORG_ID=… -e VERIFY_USER_ID=… -e VERIFY_SANDBOX_SESSION_ID=… \
  -v "$(pwd)/agent/src:/app/src:ro" \
  -v "…/2026-08-26-verify-sandbox-install.mjs:/app/verify.mjs:ro" \
  --entrypoint node agent /app/verify.mjs
```

## 这次补上的缺口

PR #31 把 `skill_install` 的 `source: "sandbox"` 加进来时，只验到
`installSkillArchive` 那一段——`package_skill.py` 的产物直接喂进去。真实链路是

```
downloadWorkspaceArchive({path})   ← GET /sessions/{id}/files/download
  → readSkillArchiveDownload       ← 流式读取 + 大小上限 + sha256
    → installSkillArchive
```

**前两跳此前只有 fake。** 本次在真实容器里跑通，因此
`docs/archive/reviews/2026-08-26-skill-closures.md` 里那条限定已可解除。

## 结果

```
PASS  using a real, active Sandbox session
        session=01M0VTPYVGAW91Z9B1SAA4Q0Z5
PASS  archive is in the real Sandbox workspace
        /home/sandbox/workspace/uploads/att_30b1f358…/demo-skill.zip
PASS  installed through the real files/download hop
        {"source_type":"sandbox_build","sha":"1dafe509a29025b7…"}
PASS  bytes fetched over the wire hash to the approved digest
PASS  SKILL.md landed in the user skill root
PASS  the script the package ships landed too
PASS  bytes that do not match the approved digest are refused
        Skill archive at … does not match the approved source_digest
        (expected 1dafe509a29025b7…, found 2a801adbaebf1a1f…);
        nothing was installed. Call skill_install again with the current digest.
PASS  the refusal names both digests
PASS  the unapproved package did not overwrite the installed one
PASS  no file from the unapproved package landed
PASS  the refusal is audited as a failed sandbox_build install

ALL CHECKS PASSED
```

## 三点关于这次验证边界的说明，别读过头

1. **归档是宿主构造后经 `files/upload` 放进工作区的，不是沙盒里 bash 打的包。**
   公共面没有执行路由（`POST /sessions/{id}/executions/command` 已不存在），
   沙盒内执行只走签名内部面且需要一个已认领的 ToolExecution fence。被验证的是
   **下载段**——那才是只有 fake 的一跳；字节怎么进到工作区并不改变它证明了什么。

2. **"掉包"是以等价形式验证的，不是原地覆写。** `files/upload` 每次新建
   `uploads/att_*/` 目录，就地覆盖同一路径做不到。改为让 manager 从一个路径下载、
   发现字节哈希不等于已批准的 digest——与真实掉包**逐字节走同一条代码路径**
   （`downloaded.sha256 !== sourceDigest`）。原地覆写的情形由单测以 fake 覆盖
   （`agent/tests/skills-install-ergonomics.test.js`）。

3. **身份与 session 借用了一个已存在的活跃会话。** `sessions/ensure` 会校验
   AgentSession 绑定，凭空捏造的身份按设计会被 409 拒绝——这本身也是一次
   顺带确认。

## 顺带记录的两个既有行为

- 同一份字节重复安装返回 `already installed … digest=…` 的**成功**（按 digest 幂等），
  不是错误。
- `files/upload` 落点是 `uploads/att_<id>/<filename>`，不是 `path` 查询参数指定的
  目录本身——传 `path` 只是加一层前缀。
