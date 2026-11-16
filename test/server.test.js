import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { NbaData } from '../lib/data.js';
import { TeamLogos } from '../lib/logos.js';

test('local HTTP server serves the app, rejects invalid routes and inputs, and shares cached scores', async () => {
  let calls = 0;
  const data = new NbaData({
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify({ events: [] }));
    },
  });
  const server = createApp(data);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Courtside/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:;/);
    for (const path of ['/app.js', '/style.css']) {
      assert.equal((await fetch(base + path)).status, 200);
    }
    assert.equal((await fetch(base + '/api/scores?date=invalid')).status, 400);
    assert.equal((await fetch(base + '/api/schedule?team=13&season=no')).status, 400);
    assert.equal((await fetch(base + '/api/standings?season=no')).status, 400);
    assert.equal((await fetch(base + '/package.json')).status, 404);
    assert.equal((await fetch(base + '/.cache/nba.json')).status, 404);
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal(calls, 0);
    const first = await (await fetch(base + '/api/scores?date=2026-11-16')).json();
    const second = await (await fetch(base + '/api/scores?date=2026-11-16')).json();
    assert.deepEqual(first.games, []);
    assert.equal(second.meta.fetchedAt, first.meta.fetchedAt);
    assert.equal(calls, 1);
    assert.equal((await (await fetch(base + '/api/usage')).json()).used, 1);
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('logo routes serve only allowed NBA images with a week of browser caching', async () => {
  const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const logos = new TeamLogos({ fetcher: async () => new Response(body, { headers: { 'Content-Type': 'image/png' } }) });
  const server = createApp(new NbaData(), logos);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/logos/lal.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=604800');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.equal((await fetch(`${base}/logos/notateam.png`)).status, 404);
    assert.equal((await fetch(`${base}/logos/lal.png`, { method: 'HEAD' })).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
