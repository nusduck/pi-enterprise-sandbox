# 所有任务书共用的约束

每份任务书都引用这一份，不再逐条重抄。**改这里等于改所有任务书**。

## 硬约束

### 1. 脱敏与围栏必须无条件

跨出模块边界的错误、日志、返回文本，物理路径一律脱敏。

**不允许**写成"调用方传了根才脱敏"或"只对某个错误类脱敏"。

> **这条是血的教训。** Wave 1 三个任务里，**两个各出过一次这个错**：
> - W1-A：脱敏参数给了默认空值 → 调用方忘了传就静默不脱敏
> - W1-B：只对 `FsError` 脱敏 → 上游抛裸 Node `Error` 时物理路径原样泄漏（**实测复现**）
>
> 两次都是在测试全绿的情况下被 review 抓到的——因为原来的测试压根没测这几条。

参照 `contract/src/errors.ts` 的 `toWireError()`：按 `ContractError` → `FsError` → `Error` → unknown 逐级兜底，没有一条漏网。

### 2. 异步迭代器要单独包

返回任何 `AsyncIterable` 时，注意错误是在调用方 `for await` 时才抛的，**那时已经出了普通 `try/catch` 的作用域**。

参照 `exec/src/fs/workspace-fs.ts` 的 `guardIterable()`——注意它用 `for await...of` 转发而不是手写 `next()`/`return()`/`throw()`，这样调用方提前 `break` 时文件描述符还能正确关闭。

### 3. 文件结构

- **单文件上限 1000 行。** `tests/test_repository_layout.py` 已对 `contract/`、`runtime/`、`exec/` 的 `src/**/*.ts` 生效，且**没有任何豁免预算**——新代码不许把既有债务复制过来。
- 按职责拆文件。入口只做组合，不要把协议解析、策略判定、持久化、编排堆在同一个文件里。
- 详见 `docs/module-layout.md`。

### 4. TypeScript

- strict 全开，另开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`
- ESM，相对 import **必须带 `.js` 后缀**（NodeNext 解析）
- 完成后必须跑通 `npx tsc --noEmit && npm test`，报告里贴**实际输出**

### 5. 注释

中文，说人话。每个文件顶部写清楚"**这是什么、为什么这样设计**"。参照 `exec/src/types.ts`。

### 6. 测试

- **必须能在 macOS 开发机上跑**（没有 bwrap、可能没有 MySQL）。把"决定要做什么"和"真的去做"分开，前者纯函数可测；需要真环境的测试打标记，检测不到时跳过。
- **测试夹具的临时目录先 `await fs.realpath()`** —— macOS 上 `/var` 是指向 `/private/var` 的符号链接，不做这步期望值会对不上。W1-B 踩过，浪费了一轮。
- 可复用 `exec/test/helpers.ts`（含 `isPathWithin` 等）。

### 7. 共享面不许各写一份

`exec/src/types.ts` 与 `contract/` 的导出是跨任务共享面。**要改签名先在报告里提出来**，不要自己动。

> 已经踩过两次：可写根（`writableRoots`）差点被两个任务各算一遍；路径常量最后确实出现了两处重复定义。
> **"同一件事两处各算一遍"正是这次重建要消灭的头号毛病**（Python 版的 `preflight` 手抄 `prepare` 的子集，两者已经悄悄分叉）。

### 8. 不要自己改设计

发现任务书与设计文档不一致、或者设计本身有问题——**在报告里如实说，不要自行决定**。

## 报告要求

完成后必须说清楚：

1. 做了什么
2. `npx tsc --noEmit && npm test` 的**实际输出**（有失败如实贴，不要粉饰）
3. 哪些 Python 用例改写了 / 哪些没法直接改写、为什么
4. **移植中发现的现有 Python 实现的 bug 或不一致** —— 这一条价值很高。逐行重写是发现这类问题最好的时机，W1-C 在隔离层找到了 3 个此前没人知道的。
5. 与设计文档不一致的地方
6. 你认为主控需要复核的点
