/**
 * 读生产源码做结构断言时用这个，别直接 readFileSync 一个写死的 `.js` 路径。
 *
 * agent 正在从 JS 迁到 TS（docs/design/agent-ts-rebuild.md 阶段 C–F）。这类
 * 守卫断言的是「这段代码里不该出现某个模式」，跟它是 .js 还是 .ts 无关——
 * 写死后缀会让每一次转换都变成一个假失败，然后被顺手改掉，守卫就废了。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** 按给定路径读源码；`.js` 读不到就试同名 `.ts`。 */
export function readSource(filePath) {
  if (existsSync(filePath)) return readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.js')) {
    const ts = `${filePath.slice(0, -3)}.ts`;
    if (existsSync(ts)) return readFileSync(ts, 'utf8');
  }
  throw new Error(`source not found: ${filePath} (nor its .ts sibling)`);
}

/** 列一个目录下的生产源码文件（.js 与 .ts 都算）。 */
export function listSources(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') || name.endsWith('.ts'))
    .map((name) => path.join(dir, name));
}
