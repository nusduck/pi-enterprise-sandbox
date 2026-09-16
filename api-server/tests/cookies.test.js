import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expiredSessionCookie, readCookie, sessionCookie } from '../src/http/cookies.js';

describe('BFF session cookie', () => {
  it('round-trips an encoded token and ignores unrelated cookies', () => {
    const token = 'header.payload/signature';
    const serialized = sessionCookie(token);
    const pair = serialized.split(';', 1)[0];
    assert.equal(readCookie({ headers: { cookie: `theme=dark; ${pair}` } }), token);
    assert.match(serialized, /HttpOnly/);
    assert.match(serialized, /SameSite=Lax/);
  });

  it('never marks the cookie Secure', () => {
    // 入口是内网 HTTP（2026-09-16 决定）：带 Secure 的 Cookie 在明文连接上
    // 不会被浏览器回传，登录会直接失效。改回 HTTPS 入口时再把它加回来。
    assert.doesNotMatch(sessionCookie('t'), /Secure/);
    assert.doesNotMatch(expiredSessionCookie(), /Secure/);
  });

  it('expires the same cookie name', () => {
    assert.match(expiredSessionCookie(), /Max-Age=0/);
  });
});
