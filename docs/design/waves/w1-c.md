# W1-C：`exec/src/isolation/` 隔离层建模 ✅

继承 [`_shared.md`](_shared.md)。

## 要解决的问题
`sandbox/isolation/bubblewrap.py` 的 `prepare()`（200-331 行）是 130 行线性 argv 追加，两个可验证后果：
1. 测试只能字符串匹配 argv
2. `preflight()` 手抄了 `prepare()` 的子集，**会静默分叉**

## 范围
只改 `exec/src/isolation/` 与 `exec/test/isolation-*.test.ts`。
**必须 import `../fs/writable-roots.js`，绝不自己另算一份可写根。**

## 交付
- `profile.ts` —— `IsolationProfile` / `NamespacePlan` / `MountPlan` / `EnvPlan` / `LaunchPlan`。**`required` 的语义要进类型**，不能退化成布尔值而丢掉"只宽恕 ENOENT、不宽恕 EACCES"
- `render.ts` —— **唯一**的 `render(profile) → argv`，纯函数
- `build.ts` —— 从执行上下文构造 profile；可写挂载由 `writableRoots()` 派生；**Skill 逐包绑定**（ADR 0006 P1 (A)）；单包挂载失败不得让整个 bwrap 起不来
- `preflight.ts` —— **渲染同一个 profile**，分叉由构造消除
- `bubblewrap.ts` —— runner。安全性质一条不减：`--unshare-user/pid/ipc/uts`、私有 procfs、`--cap-drop ALL`、`setpriv`、netns fail-closed、in-namespace nproc

## 结果
**135/136 通过**（1 条真 spawn bwrap 的用例在无 bwrap 的 macOS 上正常跳过）。

### review 抓到的问题（已修）
"可写挂载恰好等于 `writableRoots()`"这条断言被收窄成只比较 workspace/temp 两条根挂载。收窄的**理由成立**（XDG 子目录可写是因为落在可写根**下面**），但留了洞：往其它位置加一条可写挂载，全套测试都不会红。
补了**全局包含性不变量**：每条 `kind:'bind'` 挂载的源必须落在某个可写根之内（等于或后代），三种模式都跑，并加**反向用例**证明这条检查真的会拒绝越界挂载。包含性判定按路径段比较，不用裸 `startsWith`（`/a/bc` 不是 `/a/b` 的后代）。

### 它发现的 Python 版 bug（此前无人知道）
| | `prepare()` | `preflight()` |
|---|---|---|
| `--dir` | 7 个 | **2 个** |
| 只读绑定 | 6 个 | **5 个，漏 `/sbin`** |
| `/app/.venv` | 有 | **无** |
| `/etc/*` 绑定 | 9 个 | **0 个** |

**今天 preflight 通过，几乎不能说明真实启动的静态挂载能用。**

### 它主动做的一个正确泛化
Python 的"只宽恕 ENOENT"探测是**专为用户 skill 目录一条挂载手写的**。改成逐包绑定后，若照抄这个窄实现，**一个包的源目录权限坏掉（bwrap 的 `-try` 不宽恕 EACCES）会让整个启动硬失败**，用户连 `pwd` 都用不了——正好击穿"一个坏包不该让你失去 bash"。它把探测泛化到所有 `required:false` 挂载，结构性堵洞。**已认可。**
