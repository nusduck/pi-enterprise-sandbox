# W2-D：`agent/` 的 220 个 checkJs 错误 ⏳

继承 [`_shared.md`](_shared.md) 的第 3、5、8 条与报告要求（其余条目针对 TS 新代码，本任务是给既有 JS 补类型注解）。

## 背景
`agent/src` 有 246 个 `.js`，其中 **218 个写了 JSDoc 类型注解，但仓库此前没有任何 tsconfig——那些注解从未被校验过**，写错也没人知道。

主控已落地 `agent/tsconfig.json`（`allowJs` + `checkJs`，`strict: false`）。首次开启实测 **467 个错误**，其中 247 个落在 Wave 6 会整体删除的代码里（已用 `@ts-nocheck` 标注 80 个待删文件，标注会跟着文件一起被删）。

**存活代码里剩 220 个，就是本任务的范围。**

## 为什么现在做而不是 Wave 6 之后
W6-A 接线时 `agent`(JS) 要调 `runtime`(TS)，**那是最容易出错的地方**。类型检查必须在接线之前就位。
而且 `bootstrap/container.js` + `container-run-executor.js` 这两个接线核心文件本身就占了 24 个错误。

## 范围
只改 `agent/src/**/*.js` 与 `agent/config.js` 里的 **JSDoc 注解**。
**不碰**带 `@ts-nocheck` 的 80 个待删文件、`contract/`、`runtime/`、`exec/`、`sandbox/`、`api-server/`、`frontend/`。

## 错误构成
- **`TS2339`（约 78%）**：`Property X does not exist on type 'object'` —— 主流是 `@param {object} foo` 这种**占位式标注**，写了类型却没写形状。修法是补真实形状
- **`TS2345`**：把未校验的 `string` 传进期望闭合联合的地方（审批模式、A2A 状态等）。**这类可能是真 bug，逐个判断**——是该加运行时校验，还是标注本来就该更宽
- **`TS8024`**：`@param` 的参数名在函数签名里根本不存在——改了代码没改注释

## 核心要求

**这是给既有代码补类型标注，不是重构。**

- **绝对不许为了消错误而改运行时行为。** 不加/删/改任何逻辑分支、不改函数签名、不改导出
- 只允许改 JSDoc 注释；确实需要动代码时（比如加一个窄化守卫），**在报告里逐条列出并说明理由**
- 消不掉又不该改代码的，用 `@ts-expect-error` 加**中文注释说明为什么**——不要用 `@ts-ignore`（前者在错误消失后会自己报错，是自清理的）
- **不许把 `checkJs` 关掉或给文件加 `@ts-nocheck` 来绕过**

## 完成标准
`cd agent && npx tsc -p tsconfig.json` **零错误**（typescript 可用 `../exec/node_modules/.bin/tsc`）。

然后**必须跑既有测试确认没改坏行为**：`cd agent && npm test`，把实际输出发我。
**如果 `npm test` 在你开始之前就有失败，先记下基线**，报告里区分"你引入的"和"本来就红的"。

## 报告要求
除 `_shared.md` 的通用项外，额外说明：
1. **哪些是真 bug**（尤其 `TS2345` 与 `TS8024` 那批）——这是本任务最有价值的产出
2. 用了几处 `@ts-expect-error`，分别为什么
3. 有没有为了消错误而动了代码，逐条列出
