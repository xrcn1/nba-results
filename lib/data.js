import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const MINUTE = 60_000;
const DAY = 86_400_000;
const LIVE_TTL = 2 * MINUTE;

export class DataError extends Error {
  constructor(message, status = 503, retryAt = 0) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function nbaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
    && value >= '2000-01-01' && value <= '2100-12-31';
}

export function normalizeTeam(team) {
  if (!team || !/^\d+$/.test(team.id) || !team.displayName || !team.abbreviation) {
    throw new DataError('The data provider returned an invalid team.');
  }
  return {
    id: team.id,
    name: team.displayName,
    shortName: team.shortDisplayName || team.name || team.displayName,
    abbreviation: team.abbreviation,
    logo: /^[a-z\d]{2,5}$/i.test(team.abbreviation)
      ? `/logos/${team.abbreviation.toLowerCase()}.png` : null,
    color: /^[a-f\d]{6}$/i.test(team.color || '') ? `#${team.color}` : '#ef763f',
  };
}

export function normalizeStandings(data, season) {
  if (data.season?.year !== Number(season) || !Array.isArray(data.children)) {
    throw new DataError('Standings are not available for the selected season.');
  }
  const teamIds = new Set();
  const conferences = ['East', 'West'].map((abbreviation) => {
    const conference = data.children.find((item) => item.abbreviation === abbreviation);
    const entries = conference?.standings?.entries;
    if (!Array.isArray(entries) || !entries.length) {
      throw new DataError('The data provider returned incomplete conference standings.');
    }
    const teams = entries.map((entry) => {
      const team = normalizeTeam(entry.team);
      if (teamIds.has(team.id) || !Array.isArray(entry.stats)) {
        throw new DataError('The data provider returned invalid standings entries.');
      }
      teamIds.add(team.id);
      const stat = (name) => entry.stats.find((item) => item.name === name)?.value;
      const wins = stat('wins');
      const losses = stat('losses');
      const pct = stat('winPercent');
      if (!Number.isInteger(wins) || wins < 0 || !Number.isInteger(losses) || losses < 0
        || !Number.isFinite(pct) || pct < 0 || pct > 1) {
        throw new DataError('The data provider returned invalid wins, losses, or percentage.');
      }
      const seed = stat('playoffSeed');
      return {
        ...team, wins, losses, pct,
        rank: Number.isInteger(seed) && seed > 0 ? seed : null,
      };
    });
    const ranked = teams.every((team) => team.rank !== null && team.rank <= teams.length)
      && new Set(teams.map((team) => team.rank)).size === teams.length;
    if (!ranked) teams.forEach((team) => { team.rank = null; });
    teams.sort((a, b) => {
      if (ranked) return a.rank - b.rank;
      return b.pct - a.pct || b.wins - a.wins || a.name.localeCompare(b.name);
    });
    return { name: `${abbreviation === 'East' ? 'Eastern' : 'Western'} Conference`, abbreviation, teams };
  });
  return { conferences, season: data.season.displayName || season };
}

export function normalizePlayoffs(data, season) {
  if (!Array.isArray(data.events)) throw new DataError('The provider returned no postseason game list.');
  const groups = new Map();
  const seen = new Set();
  const games = [];
  for (const event of [...data.events].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    if (event.season?.type !== 3 || event.season.year !== Number(season)) continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const competition = event.competitions?.[0];
    const headline = competition?.notes?.map((note) => note.headline || '').join(' ') || '';
    const label = /\b(East|West)\s+(?:1st Round|First Round|Semifinals|Finals)\b|\bNBA Finals\b/i.exec(headline)?.[0];
    if (!label) throw new DataError('The provider returned a playoff game without a recognized round.');
    const conference = /^East/i.test(label) ? 'East' : /^West/i.test(label) ? 'West' : 'NBA';
    const round = /1st|First/i.test(label) ? 'first' : /Semifinals/i.test(label) ? 'semis' : 'finals';
    const [game] = normalizeGames({ events: [event] });
    games.push(game);
    const pair = [game.home, game.away].sort((a, b) => Number(a.id) - Number(b.id));
    const key = `${conference}:${round}:${pair.map((team) => team.id).join('-')}`;
    if (!groups.has(key)) {
      const total = competition.series?.totalCompetitions ?? 7;
      if (![5, 7].includes(total)) throw new DataError('The provider returned an unsupported playoff series format.');
      groups.set(key, {
        id: key, conference, round, bestOf: total, firstGame: game.date,
        teams: pair.map((team) => ({ ...team, wins: 0 })),
        live: false, nextGame: null, gameId: game.id, snapshot: null,
      });
    }
    const series = groups.get(key);
    if (game.state === 'final') {
      const winner = [game.home, game.away].find((team) => team.winner);
      if (!winner || game.home.winner === game.away.winner) {
        throw new DataError('The provider returned a completed playoff game without a unique winner.');
      }
      series.teams.find((team) => team.id === winner.id).wins += 1;
    }
    // Future scheduled games must not overwrite an already-played series snapshot.
    if (game.state !== 'scheduled' && competition.series?.competitors) {
      const snapshot = competition.series.competitors;
      if (snapshot.length !== 2 || !pair.every((team) => snapshot.some((item) => item.id === team.id))
        || snapshot.some((item) => !Number.isInteger(item.wins) || item.wins < 0
          || item.wins > Math.ceil(series.bestOf / 2))) {
        throw new DataError('The provider returned invalid playoff series wins.');
      }
      series.snapshot = snapshot;
    }
    if (game.state === 'live') series.live = true;
    if (game.state === 'scheduled' && !series.nextGame) series.nextGame = game.date;
    if (game.state !== 'scheduled' || !series.snapshot) series.gameId = game.id;
  }
  const series = [...groups.values()].map((item) => {
    for (const team of item.teams) {
      const wins = item.snapshot?.find((entry) => entry.id === team.id)?.wins;
      if (wins !== undefined) {
        if (wins < team.wins) throw new DataError('The provider returned inconsistent playoff series wins.');
        team.wins = wins;
      }
      if (team.wins > Math.ceil(item.bestOf / 2)) {
        throw new DataError('The provider returned too many wins in a playoff series.');
      }
    }
    const winner = item.teams.find((team) => team.wins === Math.ceil(item.bestOf / 2));
    if (winner && item.teams.every((team) => team.wins === winner.wins)) {
      throw new DataError('The provider returned two winners in a playoff series.');
    }
    const { snapshot, ...result } = item;
    return { ...result, winnerId: winner?.id || null, live: !winner && item.live,
      nextGame: winner ? null : item.nextGame };
  });
  const counts = { first: 4, semis: 2, finals: 1 };
  const conferences = ['East', 'West'].map((abbreviation) => ({
    abbreviation,
    name: `${abbreviation === 'East' ? 'Eastern' : 'Western'} Conference`,
    rounds: Object.entries(counts).map(([id, slots]) => {
      const matches = series.filter((item) => item.conference === abbreviation && item.round === id);
      if (matches.length > slots) throw new DataError('The provider returned too many playoff matchups.');
      return { id, name: id === 'first' ? 'First round' : id === 'semis' ? 'Conference semifinals' : 'Conference finals',
        slots, series: matches };
    }),
  }));
  // Align earlier columns with confirmed later-round opponents, not game dates.
  for (const conference of conferences) {
    for (let index = conference.rounds.length - 1; index > 0; index -= 1) {
      const previous = conference.rounds[index - 1];
      const ordered = [];
      for (const match of conference.rounds[index].series) {
        for (const team of match.teams) {
          const feeder = previous.series.find((item) => item.teams.some((entry) => entry.id === team.id));
          if (feeder && !ordered.includes(feeder)) ordered.push(feeder);
        }
      }
      previous.series = [...ordered, ...previous.series.filter((item) => !ordered.includes(item))];
    }
  }
  const finals = series.filter((item) => item.conference === 'NBA');
  if (finals.length > 1) throw new DataError('The provider returned more than one NBA Finals series.');
  return {
    season: `${Number(season) - 1}-${season.slice(-2)}`,
    conferences, finals: finals[0] || null,
    champion: finals[0]?.teams.find((team) => team.id === finals[0].winnerId) || null,
    seriesCount: series.length,
    refreshMs: games.some((game) => game.state === 'live') ? LIVE_TTL
      : finals[0]?.winnerId ? DAY : series.length ? 15 * MINUTE : 6 * 60 * MINUTE,
  };
}

export function normalizeGames(data) {
  if (!Array.isArray(data.events)) throw new DataError('The data provider returned no game list.');
  return data.events.map((event) => {
    const competition = event.competitions?.[0];
    const status = competition?.status || event.status;
    if (!competition || !status?.type || !Array.isArray(competition.competitors)
      || !event.id || !Number.isFinite(Date.parse(event.date))) {
      throw new DataError('The data provider returned an invalid game.');
    }
    const side = (homeAway) => {
      const competitor = competition.competitors.find((item) => item.homeAway === homeAway);
      if (!competitor) throw new DataError('The data provider returned an incomplete matchup.');
      const score = typeof competitor.score === 'object'
        ? competitor.score?.value : competitor.score;
      const numericScore = score === undefined || score === null || score === '' ? null : Number(score);
      if (numericScore !== null && (!Number.isFinite(numericScore) || numericScore < 0)) {
        throw new DataError('The data provider returned an invalid score.');
      }
      return {
        ...normalizeTeam(competitor.team),
        score: numericScore,
        winner: competitor.winner === true,
        record: competitor.records?.find((record) => record.type === 'total')?.summary || '',
      };
    };
    const state = status.type.completed ? 'final'
      : status.type.state === 'in' ? 'live' : 'scheduled';
    return {
      id: String(event.id),
      date: event.date,
      timeValid: event.timeValid !== false && competition.timeValid !== false,
      state,
      status: status.type.shortDetail || status.type.detail || status.type.description || state,
      home: side('home'),
      away: side('away'),
      venue: competition.venue?.fullName || '',
      broadcast: competition.broadcasts?.flatMap((item) => item.names || []).join(' / ')
        || competition.broadcasts?.map((item) => item.media?.shortName).filter(Boolean).join(' / ') || '',
    };
  }).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export function gameTtl(games, date, now) {
  const today = nbaDate(new Date(now));
  if (date !== null && date < today) return DAY;
  const imminent = games.some((game) => game.state === 'live'
    || (game.state === 'scheduled'
      && Math.abs(Date.parse(game.date) - now) <= 30 * MINUTE));
  if (imminent) return LIVE_TTL;
  if (date === null) return 15 * MINUTE;
  if (date > today) {
    const starts = games.filter((game) => game.state === 'scheduled')
      .map((game) => Date.parse(game.date) - now - 30 * MINUTE)
      .filter((time) => time > 0);
    return Math.min(6 * 60 * MINUTE, ...starts);
  }
  return games.length && games.every((game) => game.state === 'final')
    ? 6 * 60 * MINUTE : 15 * MINUTE;
}

// One process-wide cache and budget serves every tab, date, and favorite team.
export class NbaData {
  constructor({ cacheFile, fetcher = fetch, now = Date.now, dailyLimit = 300,
    minuteLimit = 4, logger = console } = {}) {
    this.cacheFile = cacheFile;
    this.fetcher = fetcher;
    this.now = now;
    this.dailyLimit = dailyLimit;
    this.minuteLimit = minuteLimit;
    this.logger = logger;
    this.inflight = new Map();
    this.entries = new Map();
    this.budget = { day: '', count: 0, recent: [], blockedUntil: 0, failures: 0 };
    if (cacheFile) {
      let saved;
      try {
        saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new Error(`Cannot read cache ${cacheFile}: ${error.message}`, { cause: error });
        }
      }
      if (saved) {
        if (saved.version !== 1 || !Array.isArray(saved.entries)
          || !saved.budget || !Number.isInteger(saved.budget.count)
          || !Array.isArray(saved.budget.recent)
          || !Number.isFinite(saved.budget.blockedUntil)
          || !Number.isInteger(saved.budget.failures)
          || typeof saved.budget.day !== 'string'
          || saved.entries.some((entry) => !Array.isArray(entry) || typeof entry[0] !== 'string'
            || !entry[1]?.data || !Number.isFinite(entry[1].expiresAt)
            || !Number.isFinite(entry[1].fetchedAt))) {
          throw new Error(`Invalid cache file: ${cacheFile}. Move it aside before restarting.`);
        }
        this.entries = new Map(saved.entries);
        this.budget = saved.budget;
      }
    }
  }

  persist() {
    if (!this.cacheFile) return;
    mkdirSync(dirname(this.cacheFile), { recursive: true });
    const temp = `${this.cacheFile}.tmp`;
    writeFileSync(temp, JSON.stringify({
      version: 1, entries: [...this.entries], budget: this.budget,
    }), { mode: 0o600 });
    renameSync(temp, this.cacheFile);
  }

  usage() {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.budget.day !== day) {
      this.budget.day = day;
      this.budget.count = 0;
    }
    this.budget.recent = this.budget.recent.filter((time) => time > now - MINUTE);
    return {
      used: this.budget.count,
      limit: this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.budget.count),
      minuteLimit: this.minuteLimit,
      resetsAt: Date.parse(`${day}T00:00:00Z`) + DAY,
      blockedUntil: this.budget.blockedUntil,
    };
  }

  checkBudget() {
    const now = this.now();
    const usage = this.usage();
    if (this.budget.blockedUntil > now) {
      throw new DataError('The provider is cooling down after an error. Cached data is preserved.',
        503, this.budget.blockedUntil);
    }
    if (!usage.remaining) {
      throw new DataError('The daily API safety budget is exhausted. It resets at midnight UTC.',
        429, usage.resetsAt);
    }
    if (this.budget.recent.length >= this.minuteLimit) {
      throw new DataError('The shared request limit was reached. Please wait before loading new data.',
        429, this.budget.recent[0] + MINUTE);
    }
    this.budget.count += 1;
    this.budget.recent.push(now);
    this.persist();
  }

  async load(key, path, transform, ttl) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return this.envelope(entry, false);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.refresh(key, path, transform, ttl, entry);
    this.inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(key);
    }
  }

  envelope(entry, stale, warning = '', retryAt = 0) {
    return {
      ...entry.data,
      meta: {
        source: 'ESPN public feed (unofficial)',
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
        stale,
        warning,
        retryAt,
        nextRefreshAt: Math.max(entry.expiresAt, retryAt, this.now() + 15_000),
        usage: this.usage(),
      },
    };
  }

  async refresh(key, path, transform, ttl, previous) {
    try {
      this.checkBudget();
    } catch (error) {
      if (previous && error instanceof DataError) {
        return this.envelope(previous, true, error.message, error.retryAt);
      }
      throw error;
    }
    let result;
    try {
      const response = await this.fetcher(new URL(path, BASE).href, {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAt = Number.isFinite(seconds) ? this.now() + seconds * 1000
          : Date.parse(retryAfter);
        throw new DataError(`NBA provider returned HTTP ${response.status}.`,
          503, Number.isFinite(retryAt) ? retryAt : 0);
      }
      result = transform(await response.json());
    } catch (error) {
      this.budget.failures += 1;
      this.budget.blockedUntil = Math.max(error.retryAt || 0,
        this.now() + Math.min(30 * MINUTE, 30_000 * 2 ** Math.min(this.budget.failures - 1, 6)));
      this.persist();
      this.logger.error('NBA provider request failed:', error.message);
      const message = 'NBA data is temporarily unavailable. Automatic retries are paused briefly.';
      if (previous) return this.envelope(previous, true, message, this.budget.blockedUntil);
      throw new DataError(message, 503, this.budget.blockedUntil);
    }
    const fetchedAt = this.now();
    const entry = { data: result, fetchedAt, expiresAt: fetchedAt + ttl(result, fetchedAt) };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 96) this.entries.delete(this.entries.keys().next().value);
    this.budget.failures = 0;
    // Keep an already-issued provider cooldown even if a concurrent request succeeds.
    this.persist();
    return this.envelope(entry, false);
  }

  teams() {
    return this.load('teams', 'teams?limit=30', (data) => {
      const teams = data.sports?.[0]?.leagues?.[0]?.teams;
      if (!Array.isArray(teams) || teams.length < 30) {
        throw new DataError('The data provider returned an incomplete team list.');
      }
      return { teams: teams.map(({ team }) => normalizeTeam(team))
        .sort((a, b) => a.name.localeCompare(b.name)) };
    }, () => 7 * DAY);
  }

  scoreboard(date) {
    if (!validDate(date)) throw new DataError('Use a valid date between 2000 and 2100 (YYYY-MM-DD).', 400);
    return this.load(`scores:${date}`, `scoreboard?dates=${date.replaceAll('-', '')}&limit=100`,
      (data) => ({ games: normalizeGames(data), date }),
      (data, now) => gameTtl(data.games, date, now));
  }

  standings(season) {
    if (!/^\d{4}$/.test(season) || Number(season) < 2000 || Number(season) > 2100) {
      throw new DataError('Use a season ending year between 2000 and 2100.', 400);
    }
    return this.load(`standings:${season}`,
      `/apis/v2/sports/basketball/nba/standings?season=${season}&seasontype=2`,
      (data) => normalizeStandings(data, season), () => 30 * MINUTE);
  }

  playoffs(season) {
    if (!/^\d{4}$/.test(season) || Number(season) < 2000 || Number(season) > 2100) {
      throw new DataError('Use a season ending year between 2000 and 2100.', 400);
    }
    // ESPN ignores seasontype on the scoreboard; filter the annual feed explicitly.
    return this.load(`playoffs:v1:${season}`, `scoreboard?dates=${season}&limit=1000`,
      (data) => normalizePlayoffs(data, season), (data) => data.refreshMs);
  }

  schedule(team, season, phase = '2') {
    if (!/^\d{1,3}$/.test(team) || !/^\d{4}$/.test(season)
      || Number(season) < 2000 || Number(season) > 2100 || !['1', '2', '3'].includes(phase)) {
      throw new DataError('Use a numeric team ID and a season ending year between 2000 and 2100.', 400);
    }
    return this.load(`schedule:${team}:${season}:${phase}`,
      `teams/${team}/schedule?season=${season}&seasontype=${phase}`,
      (data) => ({
        games: normalizeGames(data), team: normalizeTeam(data.team),
        season: data.season?.displayName || season,
      }), (data, now) => gameTtl(data.games, null, now));
  }
}
