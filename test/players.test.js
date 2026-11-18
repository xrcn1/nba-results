import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DataError, NbaData, normalizePlayerStats, normalizeRoster } from '../lib/data.js';
import { PlayerHeadshots } from '../lib/logos.js';
import { createApp } from '../server.js';

const instant = Date.parse('2026-11-17T18:00:00Z');
const logger = { error() {} };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const team = (id) => ({ id, displayName: `Team ${id}`, abbreviation: `T${id}`, shortDisplayName: `T${id}` });

function athlete(id, extra = {}) {
  return {
    id: String(id), displayName: `Player ${id}`, shortName: `P. ${id}`, jersey: String(id % 50),
    position: { abbreviation: 'G', displayName: 'Guard' }, age: 25, displayHeight: '6\' 4"', displayWeight: '200 lbs',
    college: { name: 'State' }, birthPlace: { city: 'Austin', state: 'TX', country: 'USA' }, experience: { years: 3 },
    status: { name: 'Active' }, headshot: { href: 'https://cdn/x.png' }, ...extra,
  };
}
const roster = (teamId, ids) => ({ team: team(teamId), coach: [{ firstName: 'Coach', lastName: teamId }], athletes: ids.map((id) => athlete(id)) });

const CATEGORIES = [
  { name: 'general', names: ['gamesPlayed', 'avgMinutes', 'avgRebounds', 'avgFouls', 'doubleDouble', 'tripleDouble', 'rebounds'] },
  { name: 'offensive', names: ['avgPoints', 'avgAssists', 'avgTurnovers', 'avgFieldGoalsMade', 'avgFieldGoalsAttempted', 'fieldGoalPct',
    'avgThreePointFieldGoalsMade', 'avgThreePointFieldGoalsAttempted', 'threePointFieldGoalPct', 'avgFreeThrowsMade',
    'avgFreeThrowsAttempted', 'freeThrowPct', 'points', 'assists'] },
  { name: 'defensive', names: ['avgSteals', 'avgBlocks'] },
];
function statLine(id, points) {
  return {
    athlete: { id: String(id) },
    categories: [
      { name: 'general', values: [10, 30.04, 5, 2, 1, 0, 50] },
      { name: 'offensive', values: [points, 4, 2, 8, 17, 47.06, 2, 6, 33.3, 3, 4, 75, points * 10, 40] },
      { name: 'defensive', values: [1.2, 0.46] },
    ],
  };
}
const statsFeed = (season, phase, lines) => ({
  requestedSeason: { year: Number(season), type: { type: Number(phase) } }, categories: CATEGORIES, athletes: lines,
});

function service(handlers, options = {}) {
  const urls = [];
  const data = new NbaData({
    now: () => instant, logger, dailyLimit: 300, minuteLimit: 10, ...options,
    fetcher: async (url) => {
      urls.push(url);
      for (const [pattern, body] of handlers) if (url.includes(pattern)) return typeof body === 'function' ? body() : json(body);
      return json({}, 500);
    },
  });
  return { data, urls };
}

test('roster normalization keeps bios, injuries, and local headshot URLs', () => {
  const result = normalizeRoster({
    team: team('18'), coach: [{ firstName: 'Mike', lastName: 'Brown' }],
    athletes: [athlete(11, { injuries: [{ status: 'Out', date: '2026-11-10' }] }), athlete(12, { headshot: undefined, age: 'x', experience: {} })],
  });
  assert.equal(result.coach, 'Mike Brown');
  assert.deepEqual(result.players[0].injury, { status: 'Out', date: '2026-11-10' });
  assert.equal(result.players[0].headshot, '/headshots/11.png');
  assert.equal(result.players[0].birthPlace, 'Austin, TX, USA');
  assert.deepEqual([result.players[1].headshot, result.players[1].age, result.players[1].experience], [null, null, null]);
  assert.throws(() => normalizeRoster({ team: team('18'), athletes: [athlete('../1')] }), DataError);
  assert.throws(() => normalizeRoster({ team: team('18'), athletes: [athlete(1), athlete(1)] }), DataError);
  assert.throws(() => normalizeRoster({ team: team('18') }), DataError);
});

test('league stats shrink to a compact per-player map and reject mismatched or changed feeds', () => {
  const result = normalizePlayerStats(statsFeed('2027', '2', [statLine(11, 21.37)]), '2027', '2');
  assert.equal(result.count, 1);
  assert.deepEqual(
    [result.players[11].gp, result.players[11].min, result.players[11].pts, result.players[11].fgPct, result.players[11].blk],
    [10, 30, 21.4, 47.1, 0.5],
  );
  assert.throws(() => normalizePlayerStats(statsFeed('2026', '2', []), '2027', '2'), /different season/);
  assert.throws(() => normalizePlayerStats(statsFeed('2027', '3', []), '2027', '2'), /different season/);
  assert.throws(() => normalizePlayerStats({ ...statsFeed('2027', '2', []), categories: CATEGORIES.slice(1) }, '2027', '2'), /changed/);
  const bad = statLine(11, 20);
  bad.categories[1].values[0] = -1;
  assert.throws(() => normalizePlayerStats(statsFeed('2027', '2', [bad]), '2027', '2'), /invalid player statistic/);
});

test('players joins roster with one shared stats feed; another team costs only its roster', async () => {
  const { data, urls } = service([
    ['teams/18/roster', roster('18', [11, 12, 13])],
    ['teams/24/roster', roster('24', [21])],
    ['statistics/byathlete', statsFeed('2027', '2', [statLine(11, 25), statLine(21, 18), statLine(99, 9)])],
  ]);
  const knicks = await data.players('18', '2027', '2');
  assert.equal(knicks.coach, 'Coach 18');
  assert.equal(knicks.players.find((player) => player.id === '11').stats.pts, 25);
  assert.equal(knicks.players.find((player) => player.id === '12').stats, null);
  assert.equal(urls.length, 2);
  const spurs = await data.players('24', '2027', '2');
  assert.equal(spurs.players[0].stats.pts, 18);
  assert.equal(urls.length, 3);
  await data.players('18', '2027', '2');
  assert.equal(urls.length, 3);
  assert.equal(Object.values(data.usage().byKind).reduce((sum, count) => sum + count, 0), 3);
});

test('stats failures still return the roster with a retry hint; preseason skips the stats call', async () => {
  const { data, urls } = service([['teams/18/roster', roster('18', [11])]]);
  const result = await data.players('18', '2027', '2');
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].stats, null);
  assert.match(result.meta.warning, /Player stats will appear shortly/);
  assert.ok(result.meta.nextRefreshAt >= instant + 15_000);
  const before = urls.length;
  const preseason = await data.players('18', '2027', '1');
  assert.equal(preseason.statsAvailable, false);
  assert.equal(preseason.meta.warning, '');
  assert.equal(urls.length, before);
  for (const args of [['x', '2027', '2'], ['18', '2001', '2'], ['18', '2027', '4']]) {
    await assert.rejects(data.players(...args), (error) => error.status === 400);
  }
  assert.equal(urls.length, before);
});

test('background requests keep a reserve for live views in both the minute and daily windows', () => {
  const minute = new NbaData({ now: () => instant, logger, minuteLimit: 4 });
  minute.checkBudget('scoreboard');
  minute.checkBudget('scoreboard');
  minute.checkBudget('schedule', 'low');
  assert.throws(() => minute.checkBudget('schedule', 'low'), /paused briefly/);
  minute.checkBudget('scoreboard');
  assert.throws(() => minute.checkBudget('scoreboard'), /shared request limit/);

  let now = instant;
  const daily = new NbaData({ now: () => now, logger, dailyLimit: 10, minuteLimit: 100 });
  for (let i = 0; i < 8; i += 1) daily.checkBudget('scoreboard');
  assert.throws(() => daily.checkBudget('schedule', 'low'), /remaining daily budget/);
  daily.checkBudget('scoreboard');
  assert.equal(daily.usage().byKind.scoreboard, 9);
  now += 86_400_000;
  assert.deepEqual(daily.usage().byKind, {});
});

test('cache lifetimes stretch under daily budget pressure', () => {
  const data = new NbaData({ now: () => instant, logger, dailyLimit: 20, minuteLimit: 100 });
  const scales = [];
  for (let i = 0; i < 19; i += 1) {
    scales.push(data.usage().ttlScale);
    data.checkBudget('scoreboard');
  }
  assert.deepEqual([scales[0], scales[10], scales[15], scales[18]], [1, 1.5, 2, 4]);
});

test('identical upstream URLs are fetched once even for different cache entries', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const data = new NbaData({
    now: () => instant, logger,
    fetcher: async () => { calls += 1; await gate; return json({ ok: true }); },
  });
  const first = data.load('a', 'same', (body) => body, () => 60_000);
  const second = data.load('b', 'same', (body) => body, () => 60_000);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(data.usage().used, 1);
});

test('headshots accept only numeric player IDs and back off for a day when ESPN has no photo', async () => {
  let calls = 0;
  let now = instant;
  const headshots = new PlayerHeadshots({
    now: () => now,
    fetcher: async (url) => {
      calls += 1;
      return url.includes('/404.png') ? new Response('nope', { status: 404 })
        : new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    },
  });
  assert.deepEqual(await headshots.load('3934672'), PNG);
  await headshots.load('3934672');
  assert.equal(calls, 1);
  for (const id of ['0', '012', 'abc', '../1', '12345678901']) {
    await assert.rejects(headshots.load(id), (error) => error.status === 404);
  }
  await assert.rejects(headshots.load('404'), (error) => error.retryAt === instant + 86_400_000);
  now += 3_600_000;
  await assert.rejects(headshots.load('404'));
  assert.equal(calls, 2);
});

test('server player and headshot routes validate input before spending budget', async () => {
  const { data, urls } = service([['teams/18/roster', roster('18', [11])], ['statistics/byathlete', statsFeed('2027', '2', [statLine(11, 20)])]]);
  const headshots = new PlayerHeadshots({ fetcher: async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }) });
  const server = createApp(data, undefined, headshots);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const query of ['team=../&season=2027', 'team=18&season=1999', 'team=18&season=2027&phase=9']) {
      assert.equal((await fetch(`${base}/api/players?${query}`)).status, 400);
    }
    assert.equal(urls.length, 0);
    const response = await fetch(`${base}/api/players?team=18&season=2027&phase=2`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).players[0].stats.pts, 20);
    const photo = await fetch(`${base}/headshots/11.png`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('cache-control'), 'public, max-age=2592000');
    assert.equal((await fetch(`${base}/headshots/0.png`)).status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
