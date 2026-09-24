/**
 * 构造 `WorkspaceFileSystem` 的唯一入口。
 *
 * **为什么必须走这里**：`WorkspaceFileSystem` 继承 `dsh-fs-local` 的
 * `LocalFileSystem`，构造时会把自己注册成 cordis 上下文里的 `fs` 服务。
 * 同一个 Context 注册第二次会抛 `service "fs" has been registered at <root>`。
 *
 * 2026-08-30 就栽在这上面：`http/app.ts` 把**共享**的 cordis Context 传给了
 * ArtifactService 的工厂，于是每个 context 的第一次 `artifact_submit` 成功、
 * 之后全部 500，而对外只显示一句 "Sandbox operation failed"。其它三个调用点
 * 各自 `new CordisContext()` 所以没事——四处各写一遍，错一处就够了。
 *
 * cordis Context 在这里只是 dsh-fs 的宿主，不承载任何跨调用状态，每次新建的
 * 成本可以忽略。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis';
import { WorkspaceFileSystem } from './workspace-fs.js';
import type { WorkspaceContext } from '../types.js';

export function makeWorkspaceFs(workspace: WorkspaceContext): WorkspaceFileSystem {
  return new WorkspaceFileSystem(new CordisContext() as never, workspace);
}
