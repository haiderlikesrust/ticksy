import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Database } from '../server/db';
import { createApp } from '../server/app';
import { config } from '../server/config';

test('readiness checks database availability and repeated probes are not rate limited', async () => {
  const memory = await openDatabase('', 'memory://');
  let unavailable = false;
  const db: Database = {
    query: (sql, params) => {
      if (unavailable) throw new Error('Database unavailable');
      return memory.query(sql, params);
    },
    close: () => memory.close(),
  };
  const { app } = await createApp({ db, timers: false });
  try {
    for (let i = 0; i < 125; i++) assert.equal((await app.inject('/api/health')).statusCode, 200);
    unavailable = true;
    const response = await app.inject('/api/health');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { ok: false, brand: 'Ticksy' });
    unavailable = false;
    assert.equal((await app.inject('/api/health')).json().spendingEnabled, false);
  } finally { await app.close(); }
});

test('Traefik and gateway proxy hops preserve client IP without trusting an injected leftmost IP', async () => {
  const original = config.TRUST_PROXY_HOPS;
  config.TRUST_PROXY_HOPS = 2;
  const db = await openDatabase('', 'memory://');
  const { app } = await createApp({ db, timers: false });
  app.get('/test-client-ip', async req => ({ ip: req.ip }));
  try {
    const response = await app.inject({
      url: '/test-client-ip', remoteAddress: '172.20.0.2',
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10, 172.21.0.2' },
    });
    assert.equal(response.json().ip, '203.0.113.10');
  } finally { config.TRUST_PROXY_HOPS = original; await app.close(); }
});
