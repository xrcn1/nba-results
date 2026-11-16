const $ = (selector) => document.querySelector(selector);
const MINUTE = 60_000;
const dateFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function easternToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

let storageWarning = '';
let savedTeam = '';
try {
  savedTeam = localStorage.getItem('courtside-favorite') || '';
} catch (error) {
  console.warn('Favorite storage unavailable:', error);
  storageWarning = 'Browser storage is unavailable. Your favorite will only be saved for this visit.';
}

const now = new Date();
const defaultSeason = now.getFullYear() + (now.getMonth() >= 6 ? 1 : 0);
const state = {
  view: 'scores', filter: 'all', date: easternToday(), favorite: savedTeam,
  team: savedTeam, season: String(defaultSeason), phase: '2', teams: [], games: [], conferences: [],
  standingsView: 'regular', playoffs: null,
  meta: null, requestId: 0, loading: false, error: '', teamError: '', retryAt: 0,
};
let timer;
let midnightTimer;
let requestController;
let teamsPromise;
let teamsRetryAt = 0;
const localResponses = new Map();

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

async function api(path, signal) {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `Local server returned HTTP ${response.status}.`);
    error.retryAt = body.retryAt || Date.now() + MINUTE;
    throw error;
  }
  return body;
}

function renderNotice() {
  const messages = [storageWarning, state.teamError, state.error, state.meta?.warning].filter(Boolean);
  const notice = $('#notice');
  notice.replaceChildren();
  notice.hidden = !messages.length;
  if (!messages.length) return;
  notice.append(node('span', '', [...new Set(messages)].join(' ')));
  if (state.meta?.stale) {
    notice.append(node('span', '', ` Showing saved data from ${new Date(state.meta.fetchedAt).toLocaleString()}.`));
  }
  const retryAt = Math.max(state.retryAt, state.meta?.retryAt || 0, teamsRetryAt);
  if (retryAt > Date.now()) {
    notice.append(node('span', '', ` Next retry after ${new Date(retryAt).toLocaleTimeString()}.`));
  }
  const retry = node('button', '', 'Try again');
  retry.type = 'button';
  retry.disabled = retryAt > Date.now() || state.loading;
  retry.addEventListener('click', () => {
    if (state.teamError) void loadTeams();
    void loadGames();
  });
  notice.append(retry);
}

function renderUsage(usage) {
  if (!usage) return;
  $('#usage-label').textContent = `${usage.used} / ${usage.limit} API calls today (UTC)`;
  $('#usage-meter').max = usage.limit;
  $('#usage-meter').value = usage.used;
  $('#usage-meter').title = `${usage.remaining} requests left. Shared across all tabs; cached reads use none.`;
}

function selectedTeam() {
  return state.view === 'favorite' ? state.favorite : state.team;
}

const failedLogos = new Map();

function teamLogo(team) {
  const badge = node('span', 'team-emblem', team.abbreviation);
  badge.setAttribute('aria-hidden', 'true');
  // Derive the URL for old disk-cache entries too; no data refetch is needed.
  const url = /^[a-z\d]{2,5}$/i.test(team.abbreviation)
    ? `/logos/${team.abbreviation.toLowerCase()}.png` : null;
  if (!url || failedLogos.get(url) > Date.now()) {
    badge.title = `${team.name} \u00b7 logo unavailable`;
    return badge;
  }
  const image = node('img', 'team-logo');
  image.alt = '';
  image.width = 48;
  image.height = 48;
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => badge.classList.add('logo-loaded'), { once: true });
  image.addEventListener('error', () => {
    failedLogos.set(url, Date.now() + 5 * MINUTE);
    console.warn(`Team logo unavailable: ${team.name}`);
    image.remove();
    badge.title = `${team.name} \u00b7 logo unavailable`;
  }, { once: true });
  image.src = url;
  badge.append(image);
  return badge;
}

function renderBanner() {
  const team = state.teams.find((item) => item.id === state.favorite);
  $('#favorite-mark').replaceChildren(team ? teamLogo(team) : document.createTextNode('\u2606'));
  $('#favorite-title').textContent = team?.name || 'Your team. Front and center.';
  $('#favorite-detail').textContent = team
    ? 'Your favorite is saved on this browser. Catch their latest results and next matchups.'
    : 'Choose a favorite in the sidebar to follow their season.';
  $('#favorite-banner .eyebrow').textContent = team ? 'YOUR HOME COURT' : 'MAKE IT PERSONAL';
  $('#favorite-action').textContent = team ? 'View my team \u2192' : 'Choose a team \u2192';
  $('#favorite-hint').textContent = team ? 'Saved on this browser. Always in your corner.' : "Pick your team. We'll keep them close.";
}

function renderControls() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view);
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    const selected = button.dataset.filter === state.filter;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('#date-controls').hidden = state.view !== 'scores';
  $('#season-controls').hidden = state.view === 'scores';
  const standings = state.view === 'standings';
  $('#standings-tabs').hidden = !standings;
  document.querySelectorAll('[data-standings-view]').forEach((button) => {
    const selected = button.dataset.standingsView === state.standingsView;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  for (const selector of ['#schedule-team', '#schedule-team-label', '#phase', '#phase-label', '#game-filters']) {
    $(selector).hidden = standings;
  }
  $('#schedule-team').disabled = state.view === 'favorite' || !state.teams.length;
  $('#schedule-team').value = selectedTeam();
  $('#game-date').value = state.date;
  $('#previous-day').disabled = state.date <= '2000-01-01';
  $('#next-day').disabled = state.date >= '2100-12-31';
  const title = state.view === 'scores' ? 'Around the league'
    : state.view === 'favorite' ? 'Your home court'
      : standings ? 'The league, ranked' : 'The season ahead';
  $('#page-title').replaceChildren(document.createTextNode(title), node('span', '', '.'));
  $('#page-description').textContent = state.view === 'scores'
    ? "The scores you came for. The matchups you don't want to miss."
    : standings ? state.standingsView === 'playoffs'
      ? 'The road to a championship. Every round, every series.'
      : 'East and West. Every team. Wins, losses, and winning percentage.'
      : state.view === 'favorite' ? 'One team. Every result. All season long.'
      : 'Plan your nights around the game. Explore a team\u2019s season.';
}

function teamRow(team, game) {
  const row = node('div', 'team-row');
  const info = node('div', 'team-info');
  const name = node('span', 'team-name', team.shortName);
  if (team.id === state.favorite) {
    const star = node('span', 'favorite-star', '\u2605');
    star.setAttribute('aria-label', 'Favorite team');
    name.append(star);
  }
  info.append(name, node('span', 'team-record', team.record || team.abbreviation));
  const score = node('span', `team-score${team.winner ? ' winner' : ''}`,
    game.state === 'scheduled' || team.score === null ? '\u2014' : String(team.score));
  row.append(teamLogo(team), info, score);
  return row;
}

function gameCard(game) {
  const favorite = game.home.id === state.favorite || game.away.id === state.favorite;
  const card = node('article', `game-card is-${game.state}${favorite ? ' favorite' : ''}`);
  card.setAttribute('aria-label', `${game.away.name} at ${game.home.name}: ${game.status}`);
  const top = node('div', 'card-top');
  top.append(node('span', `game-status ${game.state}`, game.status),
    node('span', 'card-date', dateFormatter.format(new Date(game.date))));
  const matchup = node('div', 'matchup');
  matchup.append(teamRow(game.away, game), teamRow(game.home, game));
  const bottom = node('div', 'card-bottom');
  const detail = game.state === 'scheduled'
    ? `${game.timeValid ? timeFormatter.format(new Date(game.date)) : 'Time TBD'}${game.broadcast ? ` \u00b7 ${game.broadcast}` : ''}`
    : game.venue || 'NBA';
  bottom.append(node('span', '', detail));
  const link = node('a', '', game.state === 'final' ? 'Game details \u2197' : 'Matchup \u2197');
  link.href = `https://www.espn.com/nba/game/_/gameId/${encodeURIComponent(game.id)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.setAttribute('aria-label', `${game.away.abbreviation} at ${game.home.abbreviation}: details on ESPN`);
  bottom.append(link);
  card.append(top, matchup, bottom);
  return card;
}

function renderStandings() {
  const container = $('#standings');
  container.replaceChildren();
  container.setAttribute('aria-busy', String(state.loading));
  $('#games-heading').textContent = `${Number(state.season) - 1}\u2013${state.season.slice(-2)} \u00b7 Regular-season standings`;
  const count = state.conferences.reduce((sum, conference) => sum + conference.teams.length, 0);
  $('#game-count').textContent = `${count} TEAMS`;
  if (state.loading && !count) {
    container.append(node('div', 'skeleton'), node('div', 'skeleton'));
  } else if (count) {
    for (const conference of state.conferences) {
      const panel = node('section', 'conference-panel');
      const titleId = `conference-${conference.abbreviation.toLowerCase()}`;
      const title = node('h3', 'conference-title', conference.name);
      title.id = titleId;
      panel.setAttribute('aria-labelledby', titleId);
      const table = node('table', 'standings-table');
      const caption = node('caption', 'sr-only',
        `${conference.name}: regular-season wins, losses, and winning percentage. Provider conference ranking.`);
      const head = node('thead');
      const headings = node('tr');
      for (const [label, description] of [['#', 'Conference rank'], ['Team', 'Team'], ['W', 'Wins'], ['L', 'Losses'], ['PCT', 'Winning percentage']]) {
        const cell = node('th', '', label);
        cell.scope = 'col';
        cell.title = description;
        cell.setAttribute('aria-label', description);
        headings.append(cell);
      }
      head.append(headings);
      const body = node('tbody');
      conference.teams.forEach((team, index) => {
        const row = node('tr', team.id === state.favorite ? 'favorite-standing' : '');
        const name = node('th', 'standings-team');
        name.scope = 'row';
        const identity = node('span', 'standings-identity');
        identity.append(teamLogo(team), node('span', 'standings-name', team.shortName));
        if (team.id === state.favorite) {
          const star = node('span', 'favorite-star', '\u2605');
          star.setAttribute('aria-label', 'Favorite team');
          identity.append(star);
        }
        name.append(identity);
        row.append(node('td', 'standing-rank', String(team.rank ?? index + 1)), name,
          node('td', '', String(team.wins)), node('td', '', String(team.losses)),
          node('td', 'standing-pct', team.pct.toFixed(3).replace(/^0/, '')));
        body.append(row);
      });
      table.append(caption, head, body);
      panel.append(title, table);
      container.append(panel);
    }
  } else {
    $('#empty-state').hidden = false;
    $('#empty-title').textContent = 'Standings are unavailable';
    $('#empty-description').textContent = 'Check the message above or try another season. We will retry automatically.';
  }
  renderNotice();
}

function seriesCard(series, label) {
  const card = node('article', `series-card${series?.winnerId ? ' series-complete' : ''}`);
  card.setAttribute('aria-label', label);
  if (!series) {
    card.classList.add('series-pending');
    card.append(node('p', 'series-status', 'MATCHUP TBD'));
    for (let i = 0; i < 2; i += 1) {
      card.append(node('div', 'series-team', 'To be determined'));
    }
    card.append(node('p', 'series-detail', 'Awaiting confirmed teams'));
    return card;
  }
  const leader = [...series.teams].sort((a, b) => b.wins - a.wins)[0];
  const tied = series.teams[0].wins === series.teams[1].wins;
  const score = [leader.wins, series.teams.find((team) => team.id !== leader.id).wins].join('\u2013');
  const summary = series.winnerId ? `${leader.abbreviation} wins ${score}`
    : tied ? leader.wins ? `Series tied ${score}` : 'Series not started'
      : `${leader.abbreviation} leads ${score}`;
  card.append(node('p', `series-status${series.live ? ' series-live' : ''}`, `${series.live ? 'LIVE \u00b7 ' : ''}${summary}`));
  for (const team of series.teams) {
    const row = node('div', `series-team${team.id === series.winnerId ? ' series-winner' : ''}${team.id === state.favorite ? ' series-favorite' : ''}`);
    row.append(teamLogo(team), node('span', 'series-team-name', team.shortName));
    if (team.id === state.favorite) {
      const star = node('span', 'favorite-star', '\u2605');
      star.setAttribute('aria-label', 'Favorite team');
      row.append(star);
    }
    const wins = node('strong', 'series-wins', String(team.wins));
    wins.setAttribute('aria-label', `${team.wins} series wins`);
    row.append(wins);
    card.append(row);
  }
  const details = node('div', 'series-detail');
  details.append(node('span', '', `Best of ${series.bestOf}`));
  const link = node('a', '', 'Details \u2197');
  link.href = `https://www.espn.com/nba/game/_/gameId/${encodeURIComponent(series.gameId)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  details.append(link);
  card.append(details);
  return card;
}

function renderPlayoffs() {
  const container = $('#playoffs');
  container.replaceChildren();
  container.setAttribute('aria-busy', String(state.loading));
  const bracket = state.playoffs;
  $('#games-heading').textContent = `${Number(state.season) - 1}\u2013${state.season.slice(-2)} \u00b7 Playoff bracket`;
  $('#game-count').textContent = `${bracket?.seriesCount || 0} SERIES`;
  if (!bracket) {
    if (state.loading) container.append(node('div', 'skeleton'), node('div', 'skeleton'));
    else {
      $('#empty-state').hidden = false;
      $('#empty-title').textContent = 'Playoff bracket unavailable';
      $('#empty-description').textContent = 'Check the message above or try another season. We will retry automatically.';
    }
    renderNotice();
    return;
  }
  if (!bracket.seriesCount) {
    container.append(node('p', 'playoff-note',
      'No playoff matchups have been announced for this season. Confirmed teams and series scores will appear here. Choose a previous season to see a completed bracket.'));
  }
  if (bracket.champion) {
    const champion = node('div', 'champion-banner');
    champion.append(teamLogo(bracket.champion), node('div', '', `${bracket.champion.name} \u00b7 NBA Champions`));
    container.append(champion);
  }
  container.append(node('p', 'playoff-legend', 'First round \u2192 Conference semifinals \u2192 Conference finals \u2192 NBA Finals. Numbers beside teams are series wins. Play-in games are not included.'));
  const finals = node('section', 'nba-finals');
  finals.append(node('h3', 'conference-title', 'NBA Finals'),
    seriesCard(bracket.finals, 'NBA Finals'));
  container.append(finals);
  for (const conference of bracket.conferences) {
    const section = node('section', 'bracket-conference');
    const id = `bracket-${conference.abbreviation.toLowerCase()}`;
    const heading = node('h3', 'conference-title', conference.name);
    heading.id = id;
    section.setAttribute('aria-labelledby', id);
    const rounds = node('div', 'bracket-rounds');
    for (const round of conference.rounds) {
      const column = node('section', `bracket-round bracket-${round.id}`);
      column.append(node('h4', 'round-title', round.name));
      const list = node('div', 'round-series');
      for (let i = 0; i < round.slots; i += 1) {
        const series = round.series[i];
        const label = `${conference.name}, ${round.name}, matchup ${i + 1}`;
        const card = seriesCard(series, label);
        if (series && round.id !== 'first') {
          const previous = conference.rounds[round.id === 'semis' ? 0 : 1].series
            .filter((match) => series.teams.some((team) => match.teams.some((entry) => entry.id === team.id)));
          if (previous.length) {
            card.append(node('p', 'series-path', `From: ${previous.map((match) => match.teams.map((team) => team.abbreviation).join(' / ')).join(' + ')}`));
          }
        }
        list.append(card);
      }
      column.append(list);
      rounds.append(column);
    }
    section.append(heading, rounds);
    container.append(section);
  }
  renderNotice();
}

function renderGames() {
  const grid = $('#games');
  const standings = state.view === 'standings';
  const playoffs = standings && state.standingsView === 'playoffs';
  grid.hidden = standings;
  $('#standings').hidden = !standings || playoffs;
  $('#playoffs').hidden = !playoffs;
  $('#empty-state').hidden = true;
  if (standings) {
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    if (playoffs) {
      $('#standings').replaceChildren();
      renderPlayoffs();
    } else {
      $('#playoffs').replaceChildren();
      renderStandings();
    }
    return;
  }
  $('#standings').replaceChildren();
  $('#playoffs').replaceChildren();
  grid.setAttribute('aria-busy', String(state.loading));
  grid.replaceChildren();
  $('#empty-state').hidden = true;
  let games = state.filter === 'all' ? state.games : state.games.filter((game) => game.state === state.filter);
  if (state.view === 'favorite' && state.filter === 'all') {
    games = [...games.filter((game) => game.state === 'final').slice(-4),
      ...games.filter((game) => game.state !== 'final').slice(0, 6)];
  }
  const team = state.teams.find((item) => item.id === selectedTeam());
  $('#games-heading').textContent = state.view === 'scores'
    ? `${state.date === easternToday() ? "Today's matchups" : dateFormatter.format(new Date(`${state.date}T12:00:00`))} \u00b7 NBA`
    : `${team?.shortName || 'Team'} \u00b7 ${state.view === 'favorite' && state.filter === 'all' ? 'Recent results & next games' : 'Season schedule'}`;
  $('#game-count').textContent = `${games.length} ${games.length === 1 ? 'GAME' : 'GAMES'}`;
  if (state.loading && !games.length) {
    for (let i = 0; i < 6; i += 1) grid.append(node('div', 'skeleton'));
  } else if (games.length) {
    grid.append(...games.map(gameCard));
  } else {
    $('#empty-state').hidden = false;
    const noFavorite = state.view === 'favorite' && !state.favorite;
    $('#empty-title').textContent = noFavorite ? 'Who are you rooting for?'
      : state.error ? 'The court is temporarily quiet' : 'No games on the board';
    $('#empty-description').textContent = noFavorite ? 'Choose your favorite team in the sidebar to see their season.'
      : state.error ? 'We could not load games. Check the message above; we will retry automatically.'
        : state.view === 'scores' ? 'No matchups for this date and filter. Try another date or choose All games.'
          : 'No games for this team, season, phase, and filter. Try a different selection.';
  }
  renderNotice();
}

function renderRefresh() {
  if (document.hidden) $('#refresh-status').textContent = 'Auto-refresh paused while tab is hidden';
  else if (state.loading) $('#refresh-status').textContent = state.view === 'standings'
    ? state.standingsView === 'playoffs' ? 'Checking the playoff bracket...' : 'Checking conference standings...'
    : 'Checking the scoreboard...';
  else if (state.error || state.meta?.stale) $('#refresh-status').textContent = 'Waiting to retry \u00b7 API protected';
  else if (state.view === 'favorite' && !state.favorite) $('#refresh-status').textContent = 'Choose a team to get started';
  else if (state.meta) {
    const seconds = Math.max(0, Math.ceil((state.meta.nextRefreshAt - Date.now()) / 1000));
    $('#refresh-status').textContent = `Cached \u00b7 refresh in ${Math.max(1, Math.ceil(seconds / 60))} min`;
  }
  $('#updated-at').textContent = state.meta
    ? `\u00b7 Updated ${timeFormatter.format(new Date(state.meta.fetchedAt))}` : '';
}

function queueRefresh(at) {
  clearTimeout(timer);
  if (document.hidden) return;
  if (state.teamError) at = Math.min(at, Math.max(teamsRetryAt, Date.now() + 15_000));
  timer = setTimeout(() => {
    if (state.teamError) void loadTeams();
    void loadGames();
  }, Math.min(2_147_000_000, Math.max(15_000, at - Date.now())));
}

function pathForView() {
  if (state.view === 'scores') return `/api/scores?date=${state.date}`;
  if (state.view === 'standings') return `/api/${state.standingsView === 'playoffs' ? 'playoffs' : 'standings'}?season=${state.season}`;
  if (!selectedTeam()) return null;
  return `/api/schedule?team=${encodeURIComponent(selectedTeam())}&season=${state.season}&phase=${state.phase}`;
}

async function loadGames() {
  clearTimeout(timer);
  requestController?.abort();
  const requestId = ++state.requestId;
  const path = pathForView();
  state.error = '';
  state.retryAt = 0;
  state.loading = false;
  const cached = path && localResponses.get(path);
  state.games = cached?.games || [];
  state.conferences = cached?.conferences || [];
  state.playoffs = cached?.seriesCount !== undefined ? cached : null;
  state.meta = cached?.meta || null;
  if (!path) {
    renderGames();
    renderRefresh();
    if (state.teamError) queueRefresh(teamsRetryAt);
    return;
  }
  if (cached && !cached.meta.stale && cached.meta.expiresAt > Date.now()) {
    renderGames();
    renderRefresh();
    queueRefresh(cached.meta.nextRefreshAt);
    return;
  }
  state.loading = true;
  renderGames();
  renderRefresh();
  requestController = new AbortController();
  try {
    const result = await api(path, requestController.signal);
    if (requestId !== state.requestId) return;
    localResponses.delete(path);
    localResponses.set(path, result);
    while (localResponses.size > 48) localResponses.delete(localResponses.keys().next().value);
    state.games = result.games || [];
    state.conferences = result.conferences || [];
    state.playoffs = result.seriesCount !== undefined ? result : null;
    state.meta = result.meta;
    renderUsage(result.meta.usage);
    queueRefresh(result.meta.nextRefreshAt);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.requestId) return;
    console.error('Unable to load NBA data:', error);
    state.error = error.message;
    state.retryAt = Math.max(error.retryAt || 0, Date.now() + MINUTE);
    if (state.meta) {
      state.meta = { ...state.meta, stale: true, retryAt: state.retryAt, nextRefreshAt: state.retryAt };
    }
    queueRefresh(state.retryAt);
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      renderGames();
      renderRefresh();
    }
  }
}

async function loadTeams() {
  if (teamsPromise) return teamsPromise;
  teamsPromise = (async () => {
    try {
      const result = await api('/api/teams');
      state.teams = result.teams;
      state.teamError = result.meta.warning || '';
      teamsRetryAt = result.meta.retryAt || 0;
      for (const selector of ['#favorite-team', '#schedule-team']) {
        const select = $(selector);
        select.replaceChildren();
        if (selector === '#favorite-team') {
          const option = node('option', '', 'Choose your team');
          option.value = '';
          select.append(option);
        }
        for (const team of state.teams) {
          const option = node('option', '', team.name);
          option.value = team.id;
          select.append(option);
        }
        select.disabled = false;
      }
      if (state.favorite && !state.teams.some((team) => team.id === state.favorite)) {
        state.favorite = '';
        storageWarning = 'Your saved team is no longer available. Please choose another team.';
      }
      if (!state.teams.some((team) => team.id === state.team)) state.team = state.favorite || state.teams[0].id;
      $('#favorite-team').value = state.favorite;
      renderUsage(result.meta.usage);
      renderBanner();
      renderControls();
      if (state.view === 'schedule' || state.view === 'favorite') void loadGames();
    } catch (error) {
      console.error('Unable to load teams:', error);
      state.teamError = `Could not load the team selector. ${error.message}`;
      teamsRetryAt = Math.max(error.retryAt || 0, Date.now() + MINUTE);
      $('#favorite-team').replaceChildren(node('option', '', 'Teams unavailable'));
      $('#schedule-team').replaceChildren(node('option', '', 'Teams unavailable'));
      queueRefresh(teamsRetryAt);
    } finally {
      teamsPromise = null;
      renderNotice();
    }
  })();
  return teamsPromise;
}

function changeView(view) {
  state.view = view;
  state.filter = 'all';
  renderControls();
  void loadGames();
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => changeView(button.dataset.view));
});
document.querySelectorAll('[data-standings-view]').forEach((button) => {
  button.addEventListener('click', () => {
    state.standingsView = button.dataset.standingsView;
    renderControls();
    void loadGames();
  });
});
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    renderControls();
    renderGames();
  });
});
$('#favorite-team').addEventListener('change', (event) => {
  state.favorite = event.target.value;
  if (state.favorite) state.team = state.favorite;
  try {
    localStorage.setItem('courtside-favorite', state.favorite);
  } catch (error) {
    console.warn('Could not save favorite:', error);
    storageWarning = 'Your browser could not save this favorite. It will only persist for this visit.';
  }
  renderBanner();
  renderControls();
  if (state.view !== 'scores') void loadGames();
  else renderGames();
});
$('#favorite-action').addEventListener('click', () => {
  if (state.favorite) changeView('favorite');
  else $('#favorite-team').focus();
});
$('#schedule-team').addEventListener('change', (event) => {
  state.team = event.target.value;
  void loadGames();
});
$('#season').addEventListener('change', (event) => {
  state.season = event.target.value;
  void loadGames();
});
$('#phase').addEventListener('change', (event) => {
  state.phase = event.target.value;
  void loadGames();
});
function changeDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!date || !Number.isFinite(parsed.getTime()) || date < '2000-01-01' || date > '2100-12-31') {
    state.error = 'Choose a date between 2000 and 2100.';
    renderNotice();
    return;
  }
  state.date = date;
  renderControls();
  void loadGames();
}
function shiftDate(amount) {
  const date = new Date(`${state.date}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  changeDate(date.toISOString().slice(0, 10));
}
$('#game-date').addEventListener('change', (event) => changeDate(event.target.value));
$('#previous-day').addEventListener('click', () => shiftDate(-1));
$('#next-day').addEventListener('click', () => shiftDate(1));
$('#today-button').addEventListener('click', () => changeDate(easternToday()));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    requestController?.abort();
  } else {
    if (state.teamError) void loadTeams();
    void loadGames();
  }
  renderRefresh();
});

// Follow Eastern midnight only when the user was already looking at "Today".
let lastToday = easternToday();
function watchDate() {
  const today = easternToday();
  $('#today-label').textContent = dateFormatter.format(new Date());
  if (today !== lastToday && state.date === lastToday) {
    state.date = today;
    renderControls();
    if (state.view === 'scores' && !document.hidden) void loadGames();
  }
  lastToday = today;
  renderRefresh();
  midnightTimer = setTimeout(watchDate, MINUTE);
}
window.addEventListener('pagehide', () => {
  clearTimeout(timer);
  clearTimeout(midnightTimer);
  requestController?.abort();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    watchDate();
    void loadGames();
  }
});

for (let year = defaultSeason + 1; year >= 2000; year -= 1) {
  const option = node('option', '', `${year - 1}\u2013${String(year).slice(-2)}`);
  option.value = String(year);
  $('#season').append(option);
}
$('#season').value = state.season;
renderControls();
renderBanner();
watchDate();
void loadTeams();
void loadGames();
