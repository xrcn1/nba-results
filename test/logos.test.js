import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamLogos } from '../lib/logos.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
const logger = { error() {} };

test('concurrent logo requests are deduplicated and cached in memory', async () => {
  let calls = 0;
  const logos = new TeamLogos({ fetcher: async () => { calls += 1; return image(); } });
  const results = await Promise.all(Array.from({ length: 10 }, () => logos.load('lal')));
  assert.equal(calls, 1);
  assert.deepEqual(results[0], PNG);
  await logos.load('lal');
  assert.equal(calls, 1);
  await assert.rejects(() => logos.load('../'), /Unknown NBA team/);
  await assert.rejects(() => logos.load('notateam'), /Unknown NBA team/);
  assert.equal(calls, 1);
});

test('logos persist to disk and reuse bytes after server restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'courtside-logos-'));
  try {
    const first = new TeamLogos({ cacheDirectory: dir, fetcher: async () => image() });
    await first.load('bos');
    const second = new TeamLogos({
      cacheDirectory: dir,
      fetcher: async () => { throw new Error('Should use disk cache'); },
    });
    assert.deepEqual(await second.load('bos'), PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-image and invalid-image provider failures are explicit and use five-minute cooldowns', async () => {
  for (const fetcher of [
    async () => new Response('<html>Network gateway</html>', { headers: { 'Content-Type': 'text/html' } }),
    async () => new Response('invalid png', { headers: { 'Content-Type': 'image/png' } }),
  ]) {
    const logos = new TeamLogos({ fetcher, now: () => 1000, logger });
    await assert.rejects(() => logos.load('gs'),
      (error) => error.status === 503 && error.retryAt === 301000);
    await assert.rejects(() => logos.load('gs'), /Team logo unavailable/);
    assert.equal(logos.entries.size, 0);
  }
});

test('logos refresh at the seven-day boundary and preserve saved images during outages', async () => {
  let time = 1000;
  let calls = 0;
  let offline = false;
  const logos = new TeamLogos({
    now: () => time, logger,
    fetcher: async () => {
      calls += 1;
      if (offline) throw new Error('offline');
      return image();
    },
  });
  await logos.load('utah');
  time += 7 * 86_400_000 - 1;
  await logos.load('utah');
  assert.equal(calls, 1);
  time += 1;
  await logos.load('utah');
  assert.equal(calls, 2);
  time += 7 * 86_400_000;
  offline = true;
  assert.deepEqual(await logos.load('utah'), PNG);
  assert.equal(calls, 3);
  assert.deepEqual(await logos.load('utah'), PNG);
  assert.equal(calls, 3);
});
