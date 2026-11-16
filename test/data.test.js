import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataError, NbaData, gameTtl, nbaDate, normalizeGames, normalizeStandings, normalizeTeam, validDate } from '../lib/data.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const instant = Date.parse('2026-11-17T00:00:00Z');
const logger = { error() {} };
const team = (id = '13') => ({
  id, displayName: `Team ${id}`, abbreviation: `T${id}`, shortDisplayName: `Team ${id}`,
});
function event({ state = 'pre', completed = false, date = '2026-11-17T00:30:00Z', objectScore = false } = {}) {
  return {
    id: '123', date,
    competitions: [{
      status: { type: { state, completed, shortDetail: completed ? 'Final' : state === 'in' ? 'Q3 4:32' : '7:30 PM ET' } },
      competitors: [
        { homeAway: 'home', team: team(), score: objectScore ? { value: 110 } : '110', winner: completed },
        { homeAway: 'away', team: team('2'), score: objectScore ? { value: 99 } : '99' },
      ],
    }],
  };
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const feed = (...events) => ({ events });
function standingsFeed() {
  return {
    season: { year: 2027, displayName: '2026-27' },
    children: ['West', 'East'].map((abbreviation, conference) => ({
      abbreviation,
      standings: {
        entries: [
          { team: team(String(conference * 10 + 1)), stats: [
            { name: 'wins', value: 8 }, { name: 'losses', value: 4 },
            { name: 'winPercent', value: 2 / 3 }, { name: 'playoffSeed', value: 2 },
          ] },
          { team: team(String(conference * 10 + 2)), stats: [
            { name: 'wins', value: 8 }, { name: 'losses', value: 4 },
            { name: 'winPercent', value: 2 / 3 }, { name: 'playoffSeed', value: 1 },
          ] },
        ],
      },
    })),
  };
}
function service(options = {}) {
  let time = instant;
  let calls = 0;
  const data = new NbaData({
    now: () => time, logger,
    fetcher: async () => { calls += 1; return json(feed()); },
    ...options,
  });
  return { data, advance: (amount) => { time += amount; }, calls: () => calls };
}

test('NBA dates use Eastern time, including UTC and daylight-saving boundaries', () => {
  assert.equal(nbaDate(new Date('2026-11-17T01:00Z')), '2026-11-16');
  assert.equal(nbaDate(new Date('2026-07-17T04:30Z')), '2026-07-17');
  assert.equal(nbaDate(new Date('2026-01-17T04:30Z')), '2026-01-16');
});

test('date validation rejects rollover dates, injection, and unsupported years', () => {
  for (const date of ['2026-02-29', '2026-04-31', 'bad', '2026-1-01', '1999-12-31', '2101-01-01', null]) {
    assert.equal(validDate(date), false, String(date));
  }
  assert.equal(validDate('2028-02-29'), true);
});

test('normalize scoreboard and schedule score formats, status, home/away, and winners', () => {
  for (const objectScore of [false, true]) {
    const [game] = normalizeGames(feed(event({ completed: true, objectScore })));
    assert.equal(game.home.score, 110);
    assert.equal(game.away.score, 99);
    assert.equal(game.home.winner, true);
    assert.equal(game.state, 'final');
  }
  const sample = event();
  sample.status = sample.competitions[0].status;
  delete sample.competitions[0].status;
  assert.equal(normalizeGames(feed(sample))[0].state, 'scheduled');
  assert.equal(normalizeGames(feed(event({ state: 'in' })))[0].state, 'live');
});

test('malformed provider responses fail explicitly rather than appearing as empty results', () => {
  assert.throws(() => normalizeGames({}), DataError);
  const malformed = event();
  malformed.competitions[0].competitors[0].score = 'not a number';
  assert.throws(() => normalizeGames(feed(malformed)), /invalid score/);
  malformed.competitions[0].competitors = [];
  assert.throws(() => normalizeGames(feed(malformed)), /incomplete matchup/);
});

test('adaptive TTLs match exact live, imminent, historical, future, schedule, and idle thresholds', () => {
  const games = (options) => normalizeGames(feed(event(options)));
  assert.equal(gameTtl(games({ state: 'in' }), '2026-11-16', instant), 2 * MINUTE);
  assert.equal(gameTtl(games({ date: '2026-11-17T00:20Z' }), '2026-11-16', instant), 2 * MINUTE);
  assert.equal(gameTtl(games({ state: 'in' }), '2026-11-15', instant), DAY);
  assert.equal(gameTtl([], '2026-11-18', instant), 6 * 60 * MINUTE);
  assert.equal(gameTtl([], null, instant), 15 * MINUTE);
  assert.equal(gameTtl([], '2026-11-16', instant), 15 * MINUTE);
  assert.equal(gameTtl(games({ completed: true }), '2026-11-16', instant), 6 * 60 * MINUTE);
  const beforeMidnight = Date.parse('2026-11-17T04:30:00Z');
  const earlyGame = games({ date: '2026-11-17T05:40:00Z' });
  assert.equal(gameTtl(earlyGame, '2026-11-17', beforeMidnight), 40 * MINUTE);
  assert.equal(gameTtl(earlyGame, '2026-11-17', beforeMidnight + 40 * MINUTE), 2 * MINUTE);
});

test('live data refreshes at the exact two-minute boundary, not before', async () => {
  const { data, advance } = service({
    fetcher: async () => json(feed(event({ state: 'in' }))),
  });
  await data.scoreboard('2026-11-16');
  advance(2 * MINUTE - 1);
  await data.scoreboard('2026-11-16');
  assert.equal(data.usage().used, 1);
  advance(1);
  await data.scoreboard('2026-11-16');
  assert.equal(data.usage().used, 2);
});

test('repeated cache reads make exactly one upstream call', async () => {
  const { data, calls } = service();
  await Promise.all(Array.from({ length: 20 }, () => data.scoreboard('2026-11-16')));
  assert.equal(calls(), 1);
  assert.equal((await data.scoreboard('2026-11-16')).meta.stale, false);
  assert.equal(data.usage().used, 1);
});

test('in-flight deduplication also protects requests while the network is pending', async () => {
  let release;
  let calls = 0;
  const data = new NbaData({
    now: () => instant, logger,
    fetcher: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const first = data.scoreboard('2026-11-16');
  const second = data.scoreboard('2026-11-16');
  assert.equal(calls, 1);
  release(json(feed()));
  assert.deepEqual(await first, await second);
});

test('exact four-per-rolling-minute cap spans different endpoints', async () => {
  const { data, calls, advance } = service();
  for (let day = 10; day < 14; day += 1) await data.scoreboard(`2026-11-${day}`);
  await assert.rejects(() => data.scoreboard('2026-11-14'),
    (error) => error.status === 429 && error.retryAt === instant + MINUTE);
  assert.equal(calls(), 4);
  advance(MINUTE);
  await data.scoreboard('2026-11-14');
  assert.equal(calls(), 5);
});

test('daily cap prevents calls and resets precisely at midnight UTC', async () => {
  const { data, advance, calls } = service({ dailyLimit: 2 });
  await data.scoreboard('2026-11-10');
  await data.scoreboard('2026-11-11');
  await assert.rejects(() => data.scoreboard('2026-11-12'), /daily API safety budget/);
  assert.equal(calls(), 2);
  advance(DAY);
  await data.scoreboard('2026-11-12');
  assert.equal(data.usage().used, 1);
});

test('exhausted budget still serves clearly marked stale data without using calls', async () => {
  const { data, advance, calls } = service({ dailyLimit: 1 });
  const result = await data.scoreboard('2026-11-16');
  advance(15 * MINUTE);
  const stale = await data.scoreboard('2026-11-16');
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.meta.fetchedAt, result.meta.fetchedAt);
  assert.match(stale.meta.warning, /exhausted/);
  assert.equal(calls(), 1);
});

test('429 Retry-After seconds imposes a shared provider cooldown; failures consume budget', async () => {
  let calls = 0;
  const { data, advance } = service({
    fetcher: async () => { calls += 1; return json({}, 429, { 'Retry-After': '120' }); },
  });
  await assert.rejects(() => data.scoreboard('2026-11-16'),
    (error) => error.retryAt === instant + 120_000);
  advance(MINUTE);
  await assert.rejects(() => data.scoreboard('2026-11-15'), /cooling down/);
  assert.equal(calls, 1);
  assert.equal(data.usage().used, 1);
});

test('Retry-After HTTP dates are respected', async () => {
  const retryAt = instant + 10 * MINUTE;
  const { data } = service({
    fetcher: async () => json({}, 503, { 'Retry-After': new Date(retryAt).toUTCString() }),
  });
  await assert.rejects(() => data.scoreboard('2026-11-16'), (error) => error.retryAt === retryAt);
});

test('outages back off exponentially and retain stale data; recovery clears failure count', async () => {
  let failing = false;
  const { data, advance } = service({
    fetcher: async () => {
      if (failing) throw new Error('offline');
      return json(feed());
    },
  });
  await data.scoreboard('2026-11-16');
  advance(15 * MINUTE);
  failing = true;
  const first = await data.scoreboard('2026-11-16');
  assert.equal(first.meta.stale, true);
  assert.equal(first.meta.retryAt, instant + 15 * MINUTE + 30_000);
  advance(30_000);
  const second = await data.scoreboard('2026-11-16');
  assert.equal(second.meta.retryAt, instant + 15 * MINUTE + 90_000);
  advance(MINUTE);
  failing = false;
  const recovered = await data.scoreboard('2026-11-16');
  assert.equal(recovered.meta.stale, false);
  assert.equal(data.budget.failures, 0);
});

test('invalid upstream JSON is not cached as success', async () => {
  const { data } = service({ fetcher: async () => new Response('<html>bad gateway</html>') });
  await assert.rejects(() => data.scoreboard('2026-11-16'), /temporarily unavailable/);
  assert.equal(data.entries.size, 0);
});

test('persistent cache and request budget survive restart without another provider call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'courtside-test-'));
  try {
    const cacheFile = join(dir, 'nba.json');
    const first = service({ cacheFile });
    await first.data.scoreboard('2026-11-16');
    const second = service({ cacheFile });
    assert.equal((await second.data.scoreboard('2026-11-16')).meta.stale, false);
    assert.equal(second.calls(), 0);
    assert.equal(second.data.usage().used, 1);
    writeFileSync(cacheFile, '{bad');
    assert.throws(() => service({ cacheFile }), /Cannot read cache/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider cooldown and the rolling minute budget also survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'courtside-cooldown-test-'));
  try {
    const cacheFile = join(dir, 'nba.json');
    const first = service({
      cacheFile,
      fetcher: async () => json({}, 429, { 'Retry-After': '120' }),
    });
    await assert.rejects(() => first.data.scoreboard('2026-11-16'), DataError);
    const second = service({ cacheFile });
    await assert.rejects(() => second.data.scoreboard('2026-11-15'), /cooling down/);
    assert.equal(second.calls(), 0);
    assert.equal(second.data.usage().used, 1);
    assert.deepEqual(second.data.budget.recent, [instant]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('teams cache for seven days and sort alphabetically', async () => {
  const teams = Array.from({ length: 30 }, (_, i) => ({ team: team(String(i + 1)) }));
  const { data } = service({
    fetcher: async () => json({ sports: [{ leagues: [{ teams }] }] }),
  });
  const result = await data.teams();
  assert.equal(result.teams.length, 30);
  assert.equal(result.meta.expiresAt - result.meta.fetchedAt, 7 * DAY);
  assert.deepEqual(result.teams.map((item) => item.name),
    [...result.teams.map((item) => item.name)].sort((a, b) => a.localeCompare(b)));
  await data.teams();
  assert.equal(data.usage().used, 1);
});

test('schedule requests encode the season and phase and use separate cache keys', async () => {
  const urls = [];
  const { data } = service({
    fetcher: async (url) => {
      urls.push(url);
      return json({ ...feed(event({ objectScore: true })), team: team(), season: { displayName: '2026-27' } });
    },
  });
  await data.schedule('13', '2027', '2');
  await data.schedule('13', '2027', '3');
  await data.schedule('13', '2027', '2');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /teams\/13\/schedule\?season=2027&seasontype=2$/);
  assert.match(urls[1], /seasontype=3$/);
});

test('bad query input never consumes provider budget', () => {
  const { data } = service();
  assert.throws(() => data.scoreboard('2026-02-30'), /valid date/);
  assert.throws(() => data.schedule('../', '2027'), DataError);
  assert.throws(() => data.schedule('13', 'abc'), DataError);
  assert.throws(() => data.schedule('13', '2027', '4'), DataError);
  assert.throws(() => data.standings('abc'), DataError);
  assert.throws(() => data.standings('1999'), DataError);
  assert.throws(() => data.standings('2101'), DataError);
  assert.equal(data.usage().used, 0);
});

test('team logos use valid ESPN abbreviation paths, including nonstandard abbreviations', () => {
  for (const abbreviation of ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS',
    'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI',
    'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']) {
    assert.equal(normalizeTeam({ ...team(), abbreviation }).logo,
      `/logos/${abbreviation.toLowerCase()}.png`);
  }
  assert.equal(normalizeTeam({ ...team(), abbreviation: '../bad' }).logo, null);
});

test('standings normalize East and West and preserve provider tie-break ranks and precise stats', () => {
  const result = normalizeStandings(standingsFeed(), '2027');
  assert.deepEqual(result.conferences.map((item) => item.abbreviation), ['East', 'West']);
  assert.equal(result.season, '2026-27');
  assert.deepEqual(result.conferences[0].teams.map((item) => item.rank), [1, 2]);
  assert.equal(result.conferences[0].teams[0].id, '12');
  assert.equal(result.conferences[0].teams[0].wins, 8);
  assert.equal(result.conferences[0].teams[0].losses, 4);
  assert.equal(result.conferences[0].teams[0].pct, 2 / 3);
  assert.match(result.conferences[1].teams[0].logo, /^\/logos\//);
});

test('standings accept winless teams and fall back to percentage ordering when seeds are absent', () => {
  const feed = standingsFeed();
  for (const conference of feed.children) {
    for (const entry of conference.standings.entries) {
      entry.stats = entry.stats.filter((stat) => stat.name !== 'playoffSeed');
    }
    conference.standings.entries[0].stats = [
      { name: 'wins', value: 0 }, { name: 'losses', value: 12 }, { name: 'winPercent', value: 0 },
    ];
  }
  const result = normalizeStandings(feed, '2027');
  assert.equal(result.conferences[0].teams[0].pct, 2 / 3);
  assert.equal(result.conferences[0].teams[1].pct, 0);
  assert.equal(result.conferences[0].teams[1].rank, null);
});

test('partially missing or duplicate seeds do not produce mixed or duplicate displayed ranks', () => {
  for (const seed of [undefined, 2]) {
    const feed = standingsFeed();
    const entries = feed.children[0].standings.entries;
    entries[1].stats.find((stat) => stat.name === 'playoffSeed').value = seed;
    const west = normalizeStandings(feed, '2027').conferences[1];
    assert.deepEqual(west.teams.map((team) => team.rank), [null, null]);
  }
});

test('standings reject wrong seasons, missing conferences, duplicate teams, and invalid or missing stats', () => {
  assert.throws(() => normalizeStandings(standingsFeed(), '2026'), /selected season/);
  const missing = standingsFeed();
  missing.children.pop();
  assert.throws(() => normalizeStandings(missing, '2027'), /incomplete conference/);
  const duplicate = standingsFeed();
  duplicate.children[1].standings.entries[0].team = duplicate.children[0].standings.entries[0].team;
  assert.throws(() => normalizeStandings(duplicate, '2027'), /invalid standings/);
  for (const value of [-1, 2, NaN, undefined]) {
    const invalid = standingsFeed();
    invalid.children[0].standings.entries[0].stats.find((stat) => stat.name === 'winPercent').value = value;
    assert.throws(() => normalizeStandings(invalid, '2027'), /invalid wins/);
  }
  const invalidWins = standingsFeed();
  invalidWins.children[0].standings.entries[0].stats.find((stat) => stat.name === 'wins').value = 1.5;
  assert.throws(() => normalizeStandings(invalidWins, '2027'), /invalid wins/);
});

test('standings share one request across conferences and tabs and refresh exactly every thirty minutes', async () => {
  const urls = [];
  const { data, advance } = service({
    fetcher: async (url) => { urls.push(url); return json(standingsFeed()); },
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => data.standings('2027')));
  assert.equal(urls.length, 1);
  assert.equal(urls[0], 'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2027&seasontype=2');
  assert.equal(results[0].conferences.length, 2);
  assert.equal(results[0].meta.expiresAt - results[0].meta.fetchedAt, 30 * MINUTE);
  advance(30 * MINUTE - 1);
  await data.standings('2027');
  assert.equal(urls.length, 1);
  advance(1);
  await data.standings('2027');
  assert.equal(urls.length, 2);
});

test('standings serve marked stale data when the shared budget is exhausted', async () => {
  const { data, advance } = service({
    dailyLimit: 1, fetcher: async () => json(standingsFeed()),
  });
  await data.standings('2027');
  advance(30 * MINUTE);
  const result = await data.standings('2027');
  assert.equal(result.meta.stale, true);
  assert.equal(result.conferences.length, 2);
  assert.match(result.meta.warning, /exhausted/);
  assert.equal(data.usage().used, 1);
});
