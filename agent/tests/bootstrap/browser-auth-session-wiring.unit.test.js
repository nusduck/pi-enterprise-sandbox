/**
 * 生产接线静态门禁：可撤销会话的三个边界必须在真实装配里接上，而不是只存在于
 * 手工注入的测试替身（design sso-integration-reservation §8「生产工厂接线必须同时覆盖」）。
 *
 * 这里的断言故意很窄：一旦有人把 `sessions:` 去掉、或把真实仓储换成空实现、或删掉
 * config/logout 路由分支，测试就红。真正的运行语义由
 * `tests/mysql/browser-auth-session.integration.test.js` 在真库上证明。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('browser auth production wiring', () => {
  it('injects the real session repository into the repository bundle', () => {
    const source = read('src/bootstrap/container-env.ts');
    assert.match(source, /import \{ BrowserAuthSessionRepository \}/);
    assert.match(source, /browserAuthSessions: new BrowserAuthSessionRepository\(db, \{ now \}\)/);
  });

  it('passes the session ledger into BrowserAuthService in the HTTP factory', () => {
    const source = read('src/bootstrap/http-main.ts');
    assert.match(source, /sessions: repos\.browserAuthSessions/);
    assert.match(source, /new BrowserAuthService\(/);
  });

  it('keeps config and logout on the internal auth route', () => {
    const source = read('src/presentation/http/auth-routes.ts');
    assert.match(source, /'\/internal\/auth\/config'/);
    assert.match(source, /'\/internal\/auth\/logout'/);
    assert.match(source, /browserAuthService\.authConfig/);
    assert.match(source, /browserAuthService\.logout/);
  });

  it('composes session/JWT/active-principal boundaries instead of reviving a stateless JWT', () => {
    const service = read('src/application/browser-auth-service.ts');
    assert.match(service, /new BrowserSessionService\(/);
    assert.match(service, /new BrowserSessionTokens\(/);
    assert.match(service, /new ActivePrincipalService\(/);
    // 旧的无 sid JWT 兼容路径不能复活。
    assert.doesNotMatch(service, /createToken\(/);
  });
});
