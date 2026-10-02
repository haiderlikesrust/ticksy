import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Run only against the disposable CI stack, never an operator deployment.
assert.equal(process.env.SMOKE_TEST_FIXTURE, 'true');
const base = 'http://127.0.0.1:8080';
const request = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
const health = await request('/api/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, brand: 'Ticksy', database: 'postgres', spendingEnabled: false });
for (const path of ['/', '/leaderboard', '/profile', '/admin']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  const html = await response.text();
  assert.match(html, /id="root"/);
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
    assert.equal((await request(asset)).status, 200, asset);
  }
}
for (const path of ['/assets/ticksy-logo.png', '/assets/patek-aquanaut.webp', '/fonts/manrope-variable.ttf']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
}
assert.equal((await request('/assets/missing-file.png')).status, 404);
const post = (path, data, cookie) => request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data),
});
const wallet = Keypair.generate();
const challengeResponse = await post('/api/auth/challenge', { wallet: wallet.publicKey.toBase58() });
assert.equal(challengeResponse.status, 200);
const challenge = await challengeResponse.json();
const signed = { id: challenge.id, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), wallet.secretKey)) };
const login = await post('/api/auth/verify', signed);
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie');
assert.ok(cookie?.includes('HttpOnly'));
const session = await request('/api/session', { headers: { Cookie: cookie.split(';')[0] } });
assert.equal((await session.json()).wallet, wallet.publicKey.toBase58());
assert.notEqual((await post('/api/auth/verify', signed)).status, 200);
assert.equal((await post('/api/admin/pause', { paused: false }, cookie.split(';')[0])).status, 403);
console.log('Ticksy Compose smoke passed: database, routes, assets, wallet sessions and owner protection.');
