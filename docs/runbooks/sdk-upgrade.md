# Runbook: Upgrade `@deepseek-ai/dsh-*`

Use this when bumping the pinned DeepSeek Harness packages in `agent/`. Do
**not** widen the pin to a semver range (`^` / `~`). The BFF (`api-server/`)
must **not** depend on DSH.

Pi (`@earendil-works/pi-coding-agent`) 已移除。相关决策见
[ADR 0007](../adr/0007-agent-runtime-rebuild-on-dsh.md)，兼容套件在
`agent/tests/runtime/` 与 `agent/tests/sdk-compat/`，版本 SSOT 是
`runtime-versions.json` → `dsh.packages`。

## Preconditions

- [ ] Independent task/PR (no mixed feature work).
- [ ] Note current pin: `npm ls --prefix agent @deepseek-ai/dsh-base`（必须与
      `runtime-versions.json` → `dsh.packages` 一致；cordis 看 `dsh.cordis`）
- [ ] Read upstream changelog / release notes for the candidate version.
- [ ] Confirm license remains acceptable (or re-open ADR if not).
- [ ] Confirm `engines.node` still matches runtime images and
      `runtime-versions.json` → `node.engines`.

一次升级必须**整组** `@deepseek-ai/dsh-*` 同一版本（base / app-boot / fs / llm /
llm-deepseek / session / session-persistence / shell / tools）。不要只升其中一个。

## 1. Local matrix (old vs candidate)

From repo root:

```bash
# Baseline (current pin)
npm ci --prefix agent
npm ls --prefix agent @deepseek-ai/dsh-base
npm test --prefix agent
npm --prefix agent run typecheck
```

Install candidate (example `0.1.1-rc.3` — replace with real target)：

```bash
# Exact version only, whole family
npm install --prefix agent --save-exact \
  @deepseek-ai/dsh-app-boot@0.1.1-rc.3 \
  @deepseek-ai/dsh-base@0.1.1-rc.3 \
  @deepseek-ai/dsh-fs@0.1.1-rc.3 \
  @deepseek-ai/dsh-llm@0.1.1-rc.3 \
  @deepseek-ai/dsh-llm-deepseek@0.1.1-rc.3 \
  @deepseek-ai/dsh-session@0.1.1-rc.3 \
  @deepseek-ai/dsh-session-persistence@0.1.1-rc.3 \
  @deepseek-ai/dsh-shell@0.1.1-rc.3 \
  @deepseek-ai/dsh-tools@0.1.1-rc.3
npm ls --prefix agent @deepseek-ai/dsh-base

npm test --prefix agent
npm --prefix agent run typecheck
```

`tests/runtime/boot.test.ts` 会起真实插件树。候选版本如果改了 patch `name`
语义或出厂插件 id，这条会红——那是要修 `src/runtime/plugins/manifest.ts` 的信号，
不是「把测试放宽」。

### What the suite covers (no live LLM)

| Check | File |
|-------|------|
| 组合结果（自建 provider 挂上、出厂 local/sandbox 关掉） | `agent/tests/runtime/boot.test.ts` |
| patch YAML 与 manifest 逐字节一致 | `agent/tests/runtime/plugins.test.ts` |
| 策略纯函数 | `agent/tests/runtime/policy.test.ts` |
| SSE 投影 | `agent/tests/runtime/` + `tests/fixtures/sse_events.json` |
| MCP `tools/list` 接缝 | `agent/tests/pi/mcp-seam.unit.test.js`（宿主机有 `~/.pi/agent/mcp.json` 时必失败） |

If a DSH event shape changes, update the projector and its unit tests only after
confirming that the durable platform-event and BFF SSE contracts remain compatible
with `tests/fixtures/sse_events.json`.

## 2. Gray check (staging)

1. Build **Agent image** with the candidate pin (do not change production compose
   defaults in the same PR if possible). Exec 镜像通常不用一起升——DSH 只在 agent 进程。
2. Deploy to staging with a single canary replica if available.
3. Smoke (manual or scripted against staging):
   - Multi-turn chat (history restore)
   - `write` + `submit_artifact` → UI `file_ready` + download
   - Workspace `bash` 直接执行，不产生 `approval_required`
   - High-risk external side-effect tool → `approval_required` → approve/reject
   - Client disconnect mid-run → exec 取消在途作业（no orphan runaway）
4. **Do not** run two agent images against the **same** in-flight conversation/run
   for migration validation. Short-lived parallel images for version smoke are OK
   on **separate** sessions.

## 3. Session migration notes

Current enterprise persistence:

- Conversation messages, Agent-session bindings, and session snapshots → Agent-owned MySQL
- A live DSH session is process-local, but recovery reconstructs it from the
  durable Agent-session journal after a worker restart（ADR 0007 D5）

Most DSH bumps therefore need no SQL schema migration, but they must retain
compatibility with already-persisted session entries.

When upstream changes matter:

| Change | Action |
|--------|--------|
| session format / chunk-rows | Copy representative persisted entries; prove the new image restores pre-upgrade sessions |
| Tool result / event field renames | Update `agent/src/runtime/projection/sse.ts` and its unit tests; keep durable platform events and BFF SSE types stable for frontend |
| Default built-in local fs/shell/sandbox re-enabled | **Block release** until `src/runtime/plugins/manifest.ts` still disables them and `boot.test.ts` still asserts the composed result |
| Credential provider fallback to Local | **Block release** — ADR 0007 明令不得组合出厂 `LocalCredentialProvider` |
| Model / auth storage format | Verify env-credentials + model registry still accept LLMIO key path |

For a session-entry migration, use **copy-then-validate**, keep the previous
Agent image for rollback, and never dual-write one session from two versions.

## 4. PR checklist

- [ ] `runtime-versions.json` `dsh.packages`（及如有变动的 `dsh.cordis`）updated
- [ ] `agent/package.json` 整组 `@deepseek-ai/dsh-*` **exact** version
- [ ] `npm run gen:patch` 若改了 manifest；`plugins.test.ts` 仍逐字节一致
- [ ] `agent/package-lock.json` committed and matches (`npm ci --prefix agent`)
- [ ] `uv run pytest tests/test_runtime_versions.py -q` green
- [ ] ADR 0007 实施记录更新，如果组合层有新的偏离
- [ ] `tests/runtime/boot.test.ts` green（真实插件树）
- [ ] Staging gray check notes in PR body
- [ ] No production default flips unrelated to the pin (Agent service image/config only)

## 5. Image rollback

If production misbehaves after release:

1. **Roll back the Agent image** to the previous digest/tag (compose/k8s).
2. Confirm `npm ls` inside the rolled-back image shows the previous pin.
3. Leave Agent MySQL records and exec workspaces intact.
4. Do **not** delete session snapshots solely because of an Agent rollback; multi-turn reuse still applies.
5. File a follow-up with suite gaps that missed the regression.

Rollback does not require re-running LLM evaluation if the previous image was
known-good; prioritize restore of SSE/tool path.

## 6. After success

- Update the pinned version notes in ADR 0007 if the pin itself is part of the decision surface.
- Archive any temporary candidate `node_modules` experiments.
- If exit criteria in the ADR are approached (license, unfixable API gap,
  maintenance stop), open a **new** ADR rather than expanding a fork silently.
