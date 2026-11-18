import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataError, NbaData, normalizeGames, normalizeHistory } from '../lib/data.js';
import { createApp } from '../server.js';

const DAY = 86_400_000;
const instant = Date.parse('2026-11-17T00:00:00Z');
const logger = { error() {} };
const team = (id) => ({ id, displayName: `Team ${id}`, abbreviation: `T${id}`, shortDisplayName: `T${id}` });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// ESPN team schedules use object scores and keep status on the competition.
function game(id, date, { home = true, us = 110, them = 100, period = 4, detail = 'Final', completed = true } = {}) {
  return {
    id: String(id), date,
    competitions: [{
      status: { period, type: { state: completed ? 'post' : 'pre', completed, shortDetail: detail } },
      competitors: [
        { homeAway: home ? 'home' : 'away', team: team('18'), score: completed ? { value: us } : undefined, winner: completed && us > them },
        { homeAway: home ? 'away' : 'home', team: team(String(id % 17 + 1)), score: completed ? { value: them } : undefined, winner: completed && them > us },
      ],
    }],
  };
}
const day = (start, offset) => new Date(Date.parse(start) + offset * DAY).toISOString();
const schedule = (events) => ({ team: team('18'), events });

test('overtime count comes from the period number with a status-label fallback', () => {
  const games = normalizeGames(schedule([
    game(1, '2026-01-01T00:00Z'),
    game(2, '2026-01-02T00:00Z', { period: 5, detail: 'Final/OT' }),
    game(3, '2026-01-03T00:00Z', { period: 6, detail: 'Final/2OT' }),
    game(4, '2026-01-04T00:00Z', { period: undefined, detail: 'Final/3OT' }),
  ]));
  assert.deepEqual(games.map((item) => item.overtime), [0, 1, 2, 3]);
});

test('history keeps only the newest twenty completed games from the selected team perspective', () => {
  const events = Array.from({ length: 25 }, (_, index) => game(index + 1, day('2026-01-01T00:00Z', index), {
    home: index % 2 === 0, us: index === 24 ? 98 : 110, them: 100,
  }));
  events.push(game(99, '2026-03-01T00:00Z', { completed: false, detail: '7:30 PM ET' }));
  const result = normalizeHistory(schedule(events), '18', '2026', '2', instant);
  assert.equal(result.games.length, 20);
  assert.equal(result.games[0].id, '6');
  assert.equal(result.upcoming, true);
  const last = result.games.at(-1);
  assert.deepEqual([last.result, last.teamScore, last.opponentScore, last.home], ['L', 98, 100, true]);
  assert.equal(result.games[0].home, false);
  assert.ok(result.games[1].opponent.abbreviation);
  assert.throws(() => normalizeHistory(schedule(events), '7', '2026', '2', instant), DataError);
});

test('finished past seasons are cached for a month; the current season stays live-aware', () => {
  const finished = schedule([game(1, '2026-04-01T00:00Z')]);
  assert.equal(normalizeHistory(finished, '18', '2026', '3', instant).refreshMs, 30 * DAY);
  assert.equal(normalizeHistory(schedule([]), '18', '2026', '3', instant).refreshMs, 30 * DAY);
  assert.equal(normalizeHistory(schedule([]), '18', '2027', '3', instant).refreshMs, 15 * 60_000);
});

function recentService(sources) {
  const urls = [];
  const data = new NbaData({
    now: () => instant, logger,
    fetcher: async (url) => {
      urls.push(url);
      const { searchParams } = new URL(url);
      return json(schedule(sources[`${searchParams.get('season')}:${searchParams.get('seasontype')}`] || []));
    },
  });
  return { data, urls };
}

test('recent games merge the current season with last season playoffs and regular season, newest first', async () => {
  const current = Array.from({ length: 14 }, (_, index) => game(100 + index, day('2026-10-21T23:30Z', index * 2)));
  current.push(game(200, '2026-12-01T00:30Z', { completed: false, detail: '7:30 PM ET' }));
  const playoffs = [
    game(300, '2026-06-10T00:30Z', { period: 6, detail: 'Final/2OT', us: 120, them: 118 }),
    game(301, '2026-06-14T00:30Z', { us: 90, them: 94 }),
  ];
  const regular = Array.from({ length: 10 }, (_, index) => game(400 + index, day('2026-03-20T23:30Z', index)));
  const { data, urls } = recentService({ '2027:2': current, '2026:3': playoffs, '2026:2': regular });
  const result = await data.recent('18', '2027');
  assert.equal(urls.length, 3, 'current playoffs are skipped while the regular season is unfinished');
  assert.equal(result.games.length, 20);
  assert.equal(result.games[0].id, '113');
  assert.deepEqual(result.games.slice(14, 16).map((item) => [item.id, item.phase, item.overtime]),
    [['301', '3', 0], ['300', '3', 2]]);
  assert.equal(result.games.at(-1).id, '406');
  assert.deepEqual([result.wins, result.losses], [19, 1]);
  assert.equal(result.meta.stale, false);
  await data.recent('18', '2027');
  assert.equal(urls.length, 3, 'a repeated hover is served from cache');
});

test('recent games stop requesting older seasons once twenty games are available', async () => {
  const current = Array.from({ length: 30 }, (_, index) => game(index + 1, day('2025-10-21T23:30Z', index)));
  const { data, urls } = recentService({ '2026:2': current, '2026:3': [] });
  const result = await data.recent('18', '2026');
  assert.equal(result.games.length, 20);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get('seasontype')), ['2', '3']);
});

test('recent games return a marked partial result when the shared budget runs out', async () => {
  const current = Array.from({ length: 5 }, (_, index) => game(index + 1, day('2026-10-21T23:30Z', index), { completed: true }));
  current.push(game(50, '2026-12-01T00:30Z', { completed: false }));
  const { data, urls } = recentService({ '2027:2': current });
  data.minuteLimit = 1;
  const result = await data.recent('18', '2027');
  assert.equal(urls.length, 1);
  assert.equal(result.games.length, 5);
  assert.equal(result.meta.stale, true);
  assert.match(result.meta.warning, /Showing 5 games/);
  assert.ok(result.meta.retryAt > instant);
});

test('recent route validates input before spending budget', async () => {
  const { data, urls } = recentService({});
  const server = createApp(data).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const query of ['team=abc&season=2027', 'team=18&season=1999', 'team=18']) {
      const response = await fetch(`${base}/api/recent?${query}`);
      assert.equal(response.status, 400, query);
    }
    assert.equal(urls.length, 0);
    const response = await fetch(`${base}/api/recent?team=18&season=2027`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).games, []);
  } finally {
    server.close();
  }
});
