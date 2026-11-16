import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DataError, NbaData, normalizePlayoffs } from '../lib/data.js';
import { createApp } from '../server.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const team = (id) => ({
  id, displayName: `Team ${id}`, abbreviation: `T${id}`, shortDisplayName: `Team ${id}`,
});
function game({ id = '1', round = 'East 1st Round', ids = ['2', '5'],
  date = '2026-04-20T23:00Z', state = 'post', wins = [1, 0],
  bestOf = 7, season = 2026, type = 3 } = {}) {
  return {
    id, date, season: { year: season, type },
    competitions: [{
      notes: [{ headline: `${round} - Game 1` }],
      status: { type: { state, completed: state === 'post', shortDetail: 'Game status' } },
      series: { totalCompetitions: bestOf, competitors: ids.map((id, i) => ({ id, wins: wins[i] })) },
      competitors: ids.map((id, i) => ({
        id, team: team(id), homeAway: i === 0 ? 'home' : 'away',
        score: i === 0 ? '100' : '90', winner: state === 'post' && i === 0,
      })),
    }],
  };
}
const feed = (...events) => ({ events });

test('playoffs group swapped home/away games into one series and ignore regular season, play-in, and other seasons', () => {
  const first = game();
  const second = game({ id: '2', ids: ['5', '2'], date: '2026-04-22T23:00Z', wins: [1, 1] });
  const result = normalizePlayoffs(feed(first, second, first,
    game({ id: '3', type: 2 }), game({ id: '4', type: 5 }), game({ id: '5', season: 2027 })), '2026');
  assert.equal(result.seriesCount, 1);
  const series = result.conferences[0].rounds[0].series[0];
  assert.deepEqual(series.teams.map((team) => team.wins), [1, 1]);
  assert.equal(series.winnerId, null);
  assert.equal(result.refreshMs, 15 * MINUTE);
});

test('playoffs separate all conference rounds and NBA Finals and expose the champion', () => {
  const events = [
    game(),
    game({ id: '2', round: 'East Semifinals', ids: ['2', '6'] }),
    game({ id: '3', round: 'East Finals', ids: ['2', '7'] }),
    game({ id: '4', round: 'West 1st Round', ids: ['13', '24'] }),
    game({ id: '5', round: 'West Semifinals', ids: ['13', '25'] }),
    game({ id: '6', round: 'West Finals', ids: ['13', '26'] }),
    game({ id: '7', round: 'NBA Finals', ids: ['2', '13'], wins: [4, 2] }),
  ];
  const result = normalizePlayoffs(feed(...events), '2026');
  assert.equal(result.seriesCount, 7);
  assert.deepEqual(result.conferences.map((conference) => conference.rounds.map((round) => round.series.length)),
    [[1, 1, 1], [1, 1, 1]]);
  assert.equal(result.finals.winnerId, '2');
  assert.equal(result.champion.id, '2');
  assert.equal(result.refreshMs, DAY);
  assert.deepEqual(result.conferences[0].rounds.map((round) => round.slots), [4, 2, 1]);
});

test('future scheduled snapshots cannot reset series wins or keep a won series active', () => {
  const completed = game({ wins: [4, 1] });
  const future = game({ id: '2', state: 'pre', wins: [0, 0], date: '2026-04-22T23:00Z' });
  const result = normalizePlayoffs(feed(completed, future), '2026');
  const series = result.conferences[0].rounds[0].series[0];
  assert.equal(series.teams[0].wins, 4);
  assert.equal(series.winnerId, '2');
  assert.equal(series.nextGame, null);
  assert.equal(series.gameId, '1');
});

test('earlier rounds align with confirmed later-round matchups rather than chronological order', () => {
  const result = normalizePlayoffs(feed(
    game({ id: '1', ids: ['2', '5'] }),
    game({ id: '2', ids: ['6', '7'] }),
    game({ id: '3', ids: ['8', '9'] }),
    game({ id: '4', ids: ['10', '11'] }),
    game({ id: '5', round: 'East Semifinals', ids: ['8', '10'] }),
    game({ id: '6', round: 'East Semifinals', ids: ['2', '6'] }),
    game({ id: '7', round: 'East Finals', ids: ['2', '8'] }),
  ), '2026');
  const rounds = result.conferences[0].rounds;
  assert.deepEqual(rounds[1].series.map((item) => item.teams[0].id), ['2', '8']);
  assert.deepEqual(rounds[0].series.map((item) => item.teams[0].id), ['2', '6', '8', '10']);
});

test('live games use two-minute refresh without awarding the current game early', () => {
  const result = normalizePlayoffs(feed(game({ state: 'in', wins: [2, 1] })), '2026');
  const series = result.conferences[0].rounds[0].series[0];
  assert.equal(result.refreshMs, 2 * MINUTE);
  assert.equal(series.live, true);
  assert.deepEqual(series.teams.map((team) => team.wins), [2, 1]);
  assert.equal(series.winnerId, null);
});

test('empty postseason returns an honest TBD bracket, not projected standings teams', () => {
  const result = normalizePlayoffs(feed(game({ type: 2 })), '2026');
  assert.equal(result.seriesCount, 0);
  assert.equal(result.finals, null);
  assert.equal(result.champion, null);
  assert.equal(result.refreshMs, 6 * 60 * MINUTE);
  assert.equal(result.conferences.length, 2);
  assert.equal(result.conferences[0].rounds.length, 3);
});

test('older best-of-five rounds and absent snapshots are supported', () => {
  const sample = game({ bestOf: 5, wins: [3, 0] });
  assert.equal(normalizePlayoffs(feed(sample), '2026').conferences[0].rounds[0].series[0].winnerId, '2');
  delete sample.competitions[0].series;
  assert.deepEqual(normalizePlayoffs(feed(sample), '2026').conferences[0].rounds[0].series[0].teams.map((team) => team.wins), [1, 0]);
});

test('bad provider rounds, records, winners, formats, and missing game lists fail explicitly', () => {
  assert.throws(() => normalizePlayoffs({}, '2026'), DataError);
  assert.throws(() => normalizePlayoffs(feed(game({ round: 'Unknown round' })), '2026'), /recognized round/);
  assert.throws(() => normalizePlayoffs(feed(game({ wins: [-1, 0] })), '2026'), /invalid playoff series wins/);
  assert.throws(() => normalizePlayoffs(feed(game({ wins: [0, 0] })), '2026'), /inconsistent/);
  assert.throws(() => normalizePlayoffs(feed(game({ wins: [4, 4] })), '2026'), /two winners/);
  assert.throws(() => normalizePlayoffs(feed(game({ bestOf: 9 })), '2026'), /unsupported/);
  const noWinner = game();
  noWinner.competitions[0].competitors[0].winner = false;
  assert.throws(() => normalizePlayoffs(feed(noWinner), '2026'), /unique winner/);
});

test('postseason uses one shared cached annual request and the same hard budget', async () => {
  let time = Date.parse('2026-04-20T23:30Z');
  const urls = [];
  const data = new NbaData({
    now: () => time, dailyLimit: 1, logger: { error() {} },
    fetcher: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(feed(game({ state: 'in', wins: [0, 0] }))));
    },
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => data.playoffs('2026')));
  assert.equal(urls.length, 1);
  assert.match(urls[0], /scoreboard\?dates=2026&limit=1000$/);
  assert.equal(results[0].meta.expiresAt - results[0].meta.fetchedAt, 2 * MINUTE);
  time += 2 * MINUTE;
  const stale = await data.playoffs('2026');
  assert.equal(stale.meta.stale, true);
  assert.match(stale.meta.warning, /exhausted/);
  assert.equal(urls.length, 1);
  assert.throws(() => data.playoffs('1999'), DataError);
  assert.throws(() => data.playoffs('bad'), DataError);
  assert.equal(data.usage().used, 1);
});

test('local playoff route validates seasons and serves both conferences with no extra cached calls', async () => {
  let calls = 0;
  const data = new NbaData({
    fetcher: async () => {
      calls += 1;
      return new Response(JSON.stringify(feed(game())));
    },
  });
  const server = createApp(data);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/playoffs?season=invalid`)).status, 400);
    assert.equal(calls, 0);
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${base}/api/playoffs?season=2026`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.conferences.length, 2);
      assert.equal(result.seriesCount, 1);
    }
    assert.equal(calls, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
