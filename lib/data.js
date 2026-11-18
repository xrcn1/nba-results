import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const MINUTE = 60_000;
const DAY = 86_400_000;
const HOUR = 60 * MINUTE;
const LIVE_TTL = 2 * MINUTE;
const STATS_BASE = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete';

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
    const label = status.type.shortDetail || status.type.detail || status.type.description || state;
    const period = Number(status.period);
    const overtimeLabel = /\b(\d*)OT\b/i.exec(label);
    return {
      id: String(event.id),
      date: event.date,
      timeValid: event.timeValid !== false && competition.timeValid !== false,
      state,
      status: label,
      // NBA regulation is four periods; each extra period is one overtime.
      overtime: Number.isInteger(period) && period > 4 ? period - 4
        : overtimeLabel ? Number(overtimeLabel[1] || 1) : 0,
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

export const RECENT_LIMIT = 20;

// Store only the newest completed results so 30 teams fit comfortably in the disk cache.
export function normalizeHistory(data, team, season, phase, now) {
  return historyFromGames(normalizeGames(data), normalizeTeam(data.team), team, season, phase, now);
}

export function historyFromGames(games, teamInfo, team, season, phase, now) {
  const completed = games.filter((game) => game.state === 'final'
    && game.home.score !== null && game.away.score !== null);
  const results = completed.slice(-RECENT_LIMIT).map((game) => {
    const home = game.home.id === team;
    if (!home && game.away.id !== team) {
      throw new DataError('The data provider returned a game for a different team.');
    }
    const self = home ? game.home : game.away;
    const opponent = home ? game.away : game.home;
    const won = self.winner || opponent.winner ? self.winner : self.score > opponent.score;
    return {
      id: game.id, date: game.date, phase,
      home, result: won ? 'W' : 'L',
      teamScore: self.score, opponentScore: opponent.score,
      overtime: game.overtime,
      opponent: {
        id: opponent.id, name: opponent.name, shortName: opponent.shortName,
        abbreviation: opponent.abbreviation, logo: opponent.logo,
      },
    };
  });
  const finished = games.every((game) => game.state === 'final');
  return {
    team: teamInfo, games: results,
    upcoming: games.some((game) => game.state !== 'final'),
    // A finished past season never changes; keep it for a month.
    refreshMs: finished && Number(season) < seasonFor(now) ? 30 * DAY : gameTtl(games, null, now),
  };
}

// Seasons are named by their ending year; July starts the next one.
export function seasonFor(now) {
  const today = nbaDate(new Date(now));
  return Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 7 ? 1 : 0);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRoster(data) {
  if (!Array.isArray(data.athletes)) throw new DataError('The data provider returned no roster.');
  const seen = new Set();
  const players = data.athletes.map((athlete) => {
    const id = String(athlete.id ?? '');
    if (!/^[1-9]\d{0,9}$/.test(id) || !text(athlete.displayName) || seen.has(id)) {
      throw new DataError('The data provider returned an invalid roster entry.');
    }
    seen.add(id);
    const injury = athlete.injuries?.find((item) => text(item.status));
    const age = Number(athlete.age);
    const experience = Number(athlete.experience?.years);
    return {
      id,
      name: text(athlete.displayName),
      shortName: text(athlete.shortName) || text(athlete.displayName),
      jersey: text(athlete.jersey),
      position: text(athlete.position?.abbreviation),
      positionName: text(athlete.position?.displayName),
      age: Number.isInteger(age) && age > 0 ? age : null,
      height: text(athlete.displayHeight),
      weight: text(athlete.displayWeight),
      college: text(athlete.college?.name),
      birthPlace: [athlete.birthPlace?.city, athlete.birthPlace?.state, athlete.birthPlace?.country]
        .map(text).filter(Boolean).join(', '),
      experience: Number.isInteger(experience) && experience >= 0 ? experience : null,
      status: text(athlete.status?.name) || 'Active',
      injury: injury ? { status: text(injury.status), date: text(injury.date) } : null,
      headshot: athlete.headshot?.href ? `/headshots/${id}.png` : null,
    };
  });
  const coach = data.coach?.[0];
  return {
    team: normalizeTeam(data.team),
    coach: coach ? [coach.firstName, coach.lastName].map(text).filter(Boolean).join(' ') : '',
    players,
  };
}

const STAT_FIELDS = {
  general: { gamesPlayed: 'gp', avgMinutes: 'min', avgRebounds: 'reb', avgFouls: 'pf',
    doubleDouble: 'dd', tripleDouble: 'td', rebounds: 'totalReb' },
  offensive: { avgPoints: 'pts', avgAssists: 'ast', avgTurnovers: 'tov',
    avgFieldGoalsMade: 'fgm', avgFieldGoalsAttempted: 'fga', fieldGoalPct: 'fgPct',
    avgThreePointFieldGoalsMade: 'tpm', avgThreePointFieldGoalsAttempted: 'tpa',
    threePointFieldGoalPct: 'tpPct', avgFreeThrowsMade: 'ftm', avgFreeThrowsAttempted: 'fta',
    freeThrowPct: 'ftPct', points: 'totalPts', assists: 'totalAst' },
  defensive: { avgSteals: 'stl', avgBlocks: 'blk' },
};

// One league-wide response (~6 MB) is reduced to a compact per-player map for every team.
export function normalizePlayerStats(data, season, phase) {
  if (!Array.isArray(data.athletes) || !Array.isArray(data.categories)) {
    throw new DataError('The data provider returned no player statistics.');
  }
  const requested = data.requestedSeason;
  const requestedType = requested?.type?.type ?? requested?.type;
  if (requested && (String(requested.year) !== season || String(requestedType) !== phase)) {
    throw new DataError('The data provider returned statistics for a different season.');
  }
  const names = new Map(data.categories.map((category) => [category.name, category.names || []]));
  for (const category of Object.keys(STAT_FIELDS)) {
    if (!names.get(category)?.includes(Object.keys(STAT_FIELDS[category])[0])) {
      throw new DataError('The data provider changed its player statistics format.');
    }
  }
  const players = {};
  for (const entry of data.athletes) {
    const id = String(entry.athlete?.id ?? '');
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new DataError('The data provider returned an invalid player.');
    const stats = {};
    for (const category of entry.categories || []) {
      const fields = STAT_FIELDS[category.name];
      if (!fields) continue;
      names.get(category.name).forEach((name, index) => {
        if (!fields[name]) return;
        const value = Number(category.values?.[index]);
        if (!Number.isFinite(value) || value < 0) {
          throw new DataError('The data provider returned an invalid player statistic.');
        }
        stats[fields[name]] = Math.round(value * 10) / 10;
      });
    }
    if (Number.isInteger(stats.gp)) players[id] = stats;
  }
  return { players, count: Object.keys(players).length };
}

export function combineMeta(parts, warning, retryAt, usage, now) {
  const metas = parts.filter(Boolean).map((part) => part.meta);
  const expiresAt = Math.min(...metas.map((meta) => meta.expiresAt));
  const latestRetry = Math.max(retryAt || 0, ...metas.map((meta) => meta.retryAt || 0));
  return {
    source: 'ESPN public feed (unofficial)',
    fetchedAt: Math.min(...metas.map((meta) => meta.fetchedAt)),
    expiresAt,
    stale: Boolean(warning) || metas.some((meta) => meta.stale),
    warning: warning || metas.find((meta) => meta.warning)?.warning || '',
    retryAt: latestRetry,
    // Partial results retry once the budget allows; complete ones wait for the shortest TTL.
    nextRefreshAt: Math.max(warning ? latestRetry : Math.max(expiresAt, latestRetry), now + 15_000),
    usage,
  };
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
    this.fetching = new Map();
    this.entries = new Map();
    this.budget = { day: '', count: 0, recent: [], blockedUntil: 0, failures: 0, kinds: {} };
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
        this.budget = { kinds: {}, ...saved.budget };
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
      this.budget.kinds = {};
    }
    this.budget.recent = this.budget.recent.filter((time) => time > now - MINUTE);
    return {
      used: this.budget.count,
      limit: this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.budget.count),
      minuteLimit: this.minuteLimit,
      usedThisMinute: this.budget.recent.length,
      resetsAt: Date.parse(`${day}T00:00:00Z`) + DAY,
      blockedUntil: this.budget.blockedUntil,
      ttlScale: this.ttlScale(),
      byKind: { ...this.budget.kinds },
    };
  }

  // Cache lifetimes stretch as the daily budget is consumed, so it lasts until reset.
  ttlScale() {
    const share = this.budget.count / this.dailyLimit;
    return share >= 0.9 ? 4 : share >= 0.75 ? 2 : share >= 0.5 ? 1.5 : 1;
  }

  // Background requests (hover details) leave headroom for the visible view's refreshes.
  checkBudget(kind = 'other', priority = 'high') {
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
    if (priority === 'low') {
      if (this.budget.recent.length >= Math.max(1, this.minuteLimit - 1)) {
        throw new DataError('Extra details are paused briefly to keep live data fresh.',
          429, this.budget.recent[0] + MINUTE);
      }
      if (usage.remaining <= Math.ceil(this.dailyLimit * 0.2)) {
        throw new DataError('Extra details are paused to save the remaining daily budget for scores.',
          429, usage.resetsAt);
      }
    }
    this.budget.count += 1;
    this.budget.kinds = { ...this.budget.kinds, [kind]: (this.budget.kinds?.[kind] || 0) + 1 };
    this.budget.recent.push(now);
    this.persist();
  }

  async load(key, path, transform, ttl, options = {}) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return this.envelope(entry, false);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.refresh(key, path, transform, ttl, entry, options);
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

  // Different cache entries built from the same upstream URL share one provider call.
  fetchJson(path, kind, { priority = 'high', timeout = 10_000 } = {}) {
    const url = new URL(path, BASE).href;
    if (this.fetching.has(url)) return this.fetching.get(url);
    try {
      this.checkBudget(kind, priority);
    } catch (error) {
      error.budget = true;
      return Promise.reject(error);
    }
    const pending = (async () => {
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.timeout(timeout),
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
        return await response.json();
      } catch (error) {
        this.recordFailure(error);
        throw error;
      } finally {
        this.fetching.delete(url);
      }
    })();
    this.fetching.set(url, pending);
    return pending;
  }

  recordFailure(error) {
    error.recorded = true;
    this.budget.failures += 1;
    this.budget.blockedUntil = Math.max(this.budget.blockedUntil, error.retryAt || 0,
      this.now() + Math.min(30 * MINUTE, 30_000 * 2 ** Math.min(this.budget.failures - 1, 6)));
    this.persist();
    this.logger.error('NBA provider request failed:', error.message);
  }

  async refresh(key, path, transform, ttl, previous, options) {
    // Pressure is judged by the budget used before this request.
    const scale = this.usage().ttlScale;
    let result;
    try {
      result = transform(await this.fetchJson(path, key.split(':')[0], options));
    } catch (error) {
      if (error.budget) {
        if (previous) return this.envelope(previous, true, error.message, error.retryAt);
        throw error;
      }
      if (!error.recorded) this.recordFailure(error);
      const message = 'NBA data is temporarily unavailable. Automatic retries are paused briefly.';
      if (previous) return this.envelope(previous, true, message, this.budget.blockedUntil);
      throw new DataError(message, 503, this.budget.blockedUntil);
    }
    const fetchedAt = this.now();
    const entry = {
      data: result, fetchedAt,
      expiresAt: fetchedAt + Math.round(ttl(result, fetchedAt) * scale),
    };
    this.store(key, entry);
    this.budget.failures = 0;
    // Keep an already-issued provider cooldown even if a concurrent request succeeds.
    this.persist();
    return this.envelope(entry, false);
  }

  store(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value);
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

  history(team, season, phase) {
    const key = `history:v1:${team}:${season}:${phase}`;
    const own = this.entries.get(key);
    const schedule = this.entries.get(`schedule:${team}:${season}:${phase}`);
    // A fresh full schedule (My team / Team schedule views) already holds these games.
    if (schedule && schedule.expiresAt > this.now()
      && !(own && own.expiresAt > this.now() && own.fetchedAt >= schedule.fetchedAt)) {
      const data = historyFromGames(schedule.data.games, schedule.data.team, team, season, phase,
        schedule.fetchedAt);
      this.store(key, { data, fetchedAt: schedule.fetchedAt, expiresAt: schedule.expiresAt });
    }
    return this.load(key, `teams/${team}/schedule?season=${season}&seasontype=${phase}`,
      (data) => normalizeHistory(data, team, season, phase, this.now()), (data) => data.refreshMs,
      { priority: 'low' });
  }

  roster(team) {
    if (!/^\d{1,3}$/.test(team)) throw new DataError('Use a numeric team ID.', 400);
    // ESPN publishes only the current roster; trades and signings are rare within a day.
    return this.load(`roster:v1:${team}`, `teams/${team}/roster`, normalizeRoster, () => 12 * HOUR);
  }

  playerStats(season, phase) {
    return this.load(`player-stats:v1:${season}:${phase}`,
      `${STATS_BASE}?isqualified=false&limit=1000&season=${season}&seasontype=${phase}`,
      (data) => normalizePlayerStats(data, season, phase),
      () => (Number(season) < seasonFor(this.now()) ? 30 * DAY : 3 * HOUR),
      { timeout: 30_000 });
  }

  // Current roster joined with one shared league-wide stats feed: 2 requests cover a team,
  // and every other team then costs only its roster.
  async players(team, season, phase = '2') {
    if (!/^\d{1,3}$/.test(team) || !/^\d{4}$/.test(season)
      || Number(season) < 2002 || Number(season) > 2100 || !['1', '2', '3'].includes(phase)) {
      throw new DataError('Use a numeric team ID, a season ending year, and a valid phase.', 400);
    }
    const roster = await this.roster(team);
    let stats = null;
    let warning = '';
    let retryAt = 0;
    if (phase !== '1') {
      try {
        stats = await this.playerStats(season, phase);
      } catch (error) {
        if (!(error instanceof DataError)) throw error;
        warning = `Player stats will appear shortly. ${error.message}`;
        retryAt = error.retryAt;
      }
    }
    return {
      team: roster.team,
      coach: roster.coach,
      season,
      phase,
      statsAvailable: phase !== '1',
      players: roster.players.map((player) => ({ ...player, stats: stats?.players[player.id] || null })),
      meta: combineMeta([roster, stats], warning, retryAt, this.usage(), this.now()),
    };
  }

  // Newest completed games across seasons. Sources are read newest-first and only while needed.
  async recent(team, season) {
    if (!/^\d{1,3}$/.test(team) || !/^\d{4}$/.test(season)
      || Number(season) < 2001 || Number(season) > 2100) {
      throw new DataError('Use a numeric team ID and a season ending year between 2001 and 2100.', 400);
    }
    const parts = [];
    const add = async (year, phase) => {
      const part = await this.history(team, String(year), phase);
      parts.push(part);
      return part;
    };
    const count = () => parts.reduce((sum, part) => sum + part.games.length, 0);
    let warning = '';
    let retryAt = 0;
    try {
      const regular = await add(season, '2');
      // Playoff games are only newer once the regular season has been completed.
      if (!regular.upcoming && regular.games.length) await add(season, '3');
      if (count() < RECENT_LIMIT) await add(Number(season) - 1, '3');
      if (count() < RECENT_LIMIT) await add(Number(season) - 1, '2');
    } catch (error) {
      if (!(error instanceof DataError) || !parts.length) throw error;
      warning = `Showing ${Math.min(count(), RECENT_LIMIT)} games for now. ${error.message}`;
      retryAt = error.retryAt;
    }
    const games = parts.flatMap((part) => part.games)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, RECENT_LIMIT);
    return {
      team: parts[0].team,
      games,
      wins: games.filter((game) => game.result === 'W').length,
      losses: games.filter((game) => game.result === 'L').length,
      meta: combineMeta(parts, warning, retryAt, this.usage(), this.now()),
    };
  }
}
