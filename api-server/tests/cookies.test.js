import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expiredSessionCookie, readCookie, sessionCookie } from '../http/cookies.js';

describe('BFF session cookie', () => {
  it('round-trips an encoded token and ignores unrelated cookies', () => {
    const token = 'header.payload/signature';
    const serialized = sessionCookie(token, { secure: true });
    const pair = serialized.split(';', 1)[0];
    assert.equal(readCookie({ headers: { cookie: `theme=dark; ${pair}` } }), token);
    assert.match(serialized, /HttpOnly/);
    assert.match(serialized, /SameSite=Lax/);
    assert.match(serialized, /Secure/);
  });

  it('expires the same cookie name', () => {
    assert.match(expiredSessionCookie(), /Max-Age=0/);
  });
});
