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
let savedMotion = 'on';
try {
  savedTeam = localStorage.getItem('courtside-favorite') || '';
  savedMotion = localStorage.getItem('courtside-motion') || 'on';
} catch (error) {
  console.warn('Favorite storage unavailable:', error);
  storageWarning = 'Browser storage is unavailable. Your preferences will only be saved for this visit.';
}

const now = new Date();
const defaultSeason = now.getFullYear() + (now.getMonth() >= 6 ? 1 : 0);
const state = {
  view: 'scores', filter: 'all', date: easternToday(), favorite: savedTeam,
  team: savedTeam, season: String(defaultSeason), phase: '2', teams: [], games: [], conferences: [],
  standingsView: 'regular', playoffs: null, scoreChanges: new Set(),
  meta: null, requestId: 0, loading: false, error: '', teamError: '', retryAt: 0,
};
let timer;
let midnightTimer;
let requestController;
let teamsPromise;
let teamsRetryAt = 0;
const localResponses = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let revealObserver;
let rosterObserver;
let lastPresentation = '';

function motionEnabled() {
  return savedMotion !== 'off' && !reducedMotion.matches;
}

function updateMotion() {
  const enabled = motionEnabled();
  document.documentElement.classList.toggle('motion-paused', !enabled);
  const toggle = $('#motion-toggle');
  toggle.textContent = reducedMotion.matches ? 'Motion: reduced by system' : `Motion: ${enabled ? 'on' : 'off'}`;
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.disabled = reducedMotion.matches;
  toggle.title = reducedMotion.matches ? 'Your system prefers reduced motion.' : 'Toggle decorative animations. Scores still refresh when motion is off.';
  if (!enabled) {
    revealObserver?.disconnect();
    rosterObserver?.disconnect();
    document.getAnimations().forEach((animation) => animation.cancel());
  }
}

function animateContent() {
  revealObserver?.disconnect();
  if (state.loading) return;
  const presentation = `${pathForView()}:${state.filter}:${state.favorite}`;
  if (presentation === lastPresentation) return;
  lastPresentation = presentation;
  if (!motionEnabled()) return;
  const container = state.view === 'standings'
    ? $(state.standingsView === 'playoffs' ? '#playoffs' : '#standings') : $('#games');
  const cards = [...container.querySelectorAll('.game-card, tbody tr, .series-card, .champion-banner')];
  const indexes = new Map(cards.map((card, index) => [card, index]));
  revealObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      if (!motionEnabled()) continue;
      entry.target.animate([
        { opacity: 0, transform: 'translateY(18px) scale(.98)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
      ], {
        duration: 440, delay: Math.min(indexes.get(entry.target) % 8, 5) * 45,
        easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards',
      });
    }
  }, { threshold: 0.06 });
  cards.forEach((card) => revealObserver.observe(card));
}

$('#motion-toggle').addEventListener('click', () => {
  savedMotion = savedMotion === 'off' ? 'on' : 'off';
  try {
    localStorage.setItem('courtside-motion', savedMotion);
  } catch (error) {
    console.warn('Could not save motion preference:', error);
    storageWarning = 'Your browser could not save your motion preference. It applies for this visit only.';
    renderNotice();
  }
  updateMotion();
  if (motionEnabled()) {
    lastPresentation = '';
    animateContent();
  }
});
reducedMotion.addEventListener('change', updateMotion);
updateMotion();

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
  const kinds = Object.entries(usage.byKind || {}).sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`).join(', ');
  $('#usage-meter').title = `${usage.remaining} requests left. Shared across all tabs; cached reads use none.${kinds ? ` Today: ${kinds}.` : ''}`;
  if (usage.ttlScale > 1) {
    $('#usage-label').textContent += ` \u00b7 saver mode: caches last ${usage.ttlScale}\u00d7 longer`;
  }
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
  if (state.scoreChanges.has(`${game.id}:${team.id}`)) {
    score.classList.add('score-changed');
    score.title = 'Score updated';
  }
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
        const identity = node('button', 'standings-identity history-trigger');
        identity.type = 'button';
        identity.dataset.team = team.id;
        identity.setAttribute('aria-expanded', 'false');
        identity.setAttribute('aria-controls', 'team-history');
        identity.setAttribute('aria-label', `${team.name}: show last ${RECENT_GAMES} games`);
        identity.append(teamLogo(team), node('span', 'standings-name', team.shortName));
        if (team.id === state.favorite) {
          const star = node('span', 'favorite-star', '\u2605');
          star.setAttribute('aria-hidden', 'true');
          identity.append(star);
          identity.setAttribute('aria-label', `${team.name}, your favorite: show last ${RECENT_GAMES} games`);
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
  syncHistoryAnchor();
  renderNotice();
}

const RECENT_GAMES = 20;
const historyDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
const historyResponses = new Map();
const historyRequests = new Map();
const historyCard = {
  team: '', season: '', anchor: null, showTimer: 0, hideTimer: 0, frame: 0,
  error: '', pointerType: '', suppressFocus: false,
};

function historyPath(team) {
  return `/api/recent?team=${encodeURIComponent(team)}&season=${state.season}`;
}

function historyPanel() {
  let panel = $('#team-history');
  if (!panel) {
    panel = node('section', 'team-history');
    panel.id = 'team-history';
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.addEventListener('pointerenter', () => clearTimeout(historyCard.hideTimer));
    panel.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') scheduleHistoryHide();
    });
    panel.addEventListener('focusout', (event) => {
      if (!panel.contains(event.relatedTarget) && event.relatedTarget !== historyCard.anchor) hideHistory();
    });
    document.body.append(panel);
  }
  return panel;
}

function positionHistory() {
  cancelAnimationFrame(historyCard.frame);
  historyCard.frame = requestAnimationFrame(() => {
    const panel = $('#team-history');
    if (!panel || panel.hidden || !historyCard.anchor?.isConnected) return;
    const gap = 10;
    const anchor = historyCard.anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const roomRight = innerWidth - anchor.right - gap;
    let left;
    let top;
    if (roomRight >= width + 8) {
      left = anchor.right + gap;
      top = anchor.top + anchor.height / 2 - height / 2;
      panel.dataset.side = 'right';
    } else {
      left = anchor.left;
      const below = innerHeight - anchor.bottom - gap;
      top = below >= height || below >= anchor.top ? anchor.bottom + gap : anchor.top - gap - height;
      panel.dataset.side = 'below';
    }
    panel.style.left = `${Math.round(Math.max(8, Math.min(left, innerWidth - width - 8)))}px`;
    panel.style.top = `${Math.round(Math.max(8, Math.min(top, innerHeight - height - 8)))}px`;
  });
}

function historyRow(game) {
  const row = node('tr', `history-${game.result === 'W' ? 'win' : 'loss'}`);
  const date = node('td', 'history-date', historyDate.format(new Date(game.date)));
  if (game.phase === '3') date.append(node('span', 'history-tag', 'PO'));
  const opponent = node('td');
  const matchup = node('span', 'history-opponent');
  const versus = node('span', 'history-versus', game.home ? 'vs' : '@');
  opponent.title = `${game.home ? 'vs' : 'at'} ${game.opponent.name}${game.phase === '3' ? ' \u00b7 Playoffs' : ''}`;
  matchup.append(versus, teamLogo(game.opponent), node('span', '', game.opponent.abbreviation));
  opponent.append(matchup);
  const result = node('td', 'history-result');
  result.append(node('span', `result-pill ${game.result === 'W' ? 'win' : 'loss'}`, game.result));
  const score = node('td', 'history-score', `${game.teamScore}\u2013${game.opponentScore}`);
  const periods = node('td', `history-time${game.overtime ? ' overtime' : ''}`,
    game.overtime ? `${game.overtime > 1 ? game.overtime : ''}OT` : 'Reg');
  periods.title = game.overtime
    ? `${game.overtime} overtime period${game.overtime > 1 ? 's' : ''}` : 'Regulation (48 minutes)';
  row.append(date, opponent, result, score, periods);
  return row;
}

function renderHistory() {
  const panel = historyPanel();
  const team = state.teams.find((item) => item.id === historyCard.team)
    || state.conferences.flatMap((conference) => conference.teams).find((item) => item.id === historyCard.team);
  if (!team) return;
  const path = historyPath(team.id);
  const data = historyResponses.get(path);
  const request = historyRequests.get(path);
  panel.setAttribute('aria-label', `${team.name}: last ${RECENT_GAMES} games`);
  panel.setAttribute('aria-busy', String(Boolean(request && !data)));
  const header = node('header', 'history-header');
  const titles = node('div', 'history-titles');
  titles.append(node('span', 'eyebrow', `LAST ${RECENT_GAMES} GAMES`), node('strong', '', team.name));
  header.append(teamLogo(team), titles);
  const content = [header];
  if (data?.games.length) {
    const overtime = data.games.filter((game) => game.overtime).length;
    const streakResult = data.games[0].result;
    const streak = data.games.findIndex((game) => game.result !== streakResult);
    const summary = node('div', 'history-summary');
    summary.id = 'team-history-summary';
    summary.setAttribute('aria-label', `Last ${data.games.length}: ${data.wins} wins, ${data.losses} losses, ${streakResult === 'W' ? 'won' : 'lost'} ${streak === -1 ? data.games.length : streak} straight, ${overtime} overtime ${overtime === 1 ? 'game' : 'games'}`);
    summary.append(
      node('span', 'history-record', `${data.wins}\u2013${data.losses}`),
      node('span', '', `${streakResult}${streak === -1 ? data.games.length : streak} streak`),
      node('span', '', `${overtime} OT ${overtime === 1 ? 'game' : 'games'}`),
    );
    const form = node('div', 'history-form');
    form.setAttribute('aria-hidden', 'true');
    form.title = 'Oldest to newest';
    [...data.games].reverse().forEach((game, index) => {
      const dot = node('span', `form-dot ${game.result === 'W' ? 'win' : 'loss'}`);
      dot.style.setProperty('--i', index);
      form.append(dot);
    });
    const scroller = node('div', 'history-scroll');
    const table = node('table', 'history-table');
    table.append(node('caption', 'sr-only',
      `${team.name}: last ${data.games.length} completed games, newest first. Score is ${team.abbreviation} first.`));
    const head = node('thead');
    const headings = node('tr');
    for (const label of ['Date', 'Opponent', 'W/L', 'Score', 'Time']) {
      const cell = node('th', '', label);
      cell.scope = 'col';
      headings.append(cell);
    }
    head.append(headings);
    const body = node('tbody');
    body.append(...data.games.map(historyRow));
    table.append(head, body);
    scroller.append(table);
    content.push(summary, form, scroller);
    if (data.games.length < RECENT_GAMES && !data.meta.warning) {
      content.push(node('p', 'history-note', `Only ${data.games.length} completed games are available so far.`));
    }
  } else if (data) {
    content.push(node('p', 'history-note', 'No completed games yet for this team.'));
  } else if (request) {
    const loading = node('div', 'history-loading');
    for (let i = 0; i < 5; i += 1) loading.append(node('span', 'history-skeleton'));
    content.push(loading);
  }
  const problem = historyCard.error || data?.meta.warning;
  if (problem) content.push(node('p', 'history-warning', problem));
  if (data) {
    content.push(node('p', 'history-source',
      `Score shows ${team.abbreviation} first \u00b7 PO = playoffs \u00b7 Updated ${timeFormatter.format(new Date(data.meta.fetchedAt))}`));
  }
  panel.replaceChildren(...content);
  positionHistory();
}

async function loadHistory(team) {
  const path = historyPath(team);
  const cached = historyResponses.get(path);
  historyCard.error = '';
  if (cached && !cached.meta.stale && cached.meta.expiresAt > Date.now()) return;
  if (cached && cached.meta.retryAt > Date.now()) return;
  if (historyRequests.has(path)) return;
  const request = api(path);
  historyRequests.set(path, request);
  if (historyCard.team === team) renderHistory();
  try {
    const result = await request;
    historyResponses.delete(path);
    historyResponses.set(path, result);
    while (historyResponses.size > 40) historyResponses.delete(historyResponses.keys().next().value);
    renderUsage(result.meta.usage);
  } catch (error) {
    console.error('Unable to load recent games:', error);
    if (historyCard.team === team) historyCard.error = `${error.message} Hover again in a minute.`;
  } finally {
    historyRequests.delete(path);
    if (historyCard.team === team && !$('#team-history').hidden) renderHistory();
  }
}

function showHistory(anchor) {
  clearTimeout(historyCard.showTimer);
  clearTimeout(historyCard.hideTimer);
  if (historyCard.anchor && historyCard.anchor !== anchor) historyCard.anchor.setAttribute('aria-expanded', 'false');
  const panel = historyPanel();
  const changed = historyCard.team !== anchor.dataset.team || panel.hidden;
  historyCard.anchor = anchor;
  historyCard.team = anchor.dataset.team;
  historyCard.season = state.season;
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-describedby', 'team-history-summary');
  panel.hidden = false;
  if (changed) historyCard.error = '';
  renderHistory();
  if (changed && motionEnabled()) {
    panel.animate([
      { opacity: 0, transform: 'translateY(6px) scale(.97)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  void loadHistory(historyCard.team);
}

function hideHistory() {
  clearTimeout(historyCard.showTimer);
  clearTimeout(historyCard.hideTimer);
  const panel = $('#team-history');
  if (panel) panel.hidden = true;
  historyCard.anchor?.setAttribute('aria-expanded', 'false');
  historyCard.anchor?.removeAttribute('aria-describedby');
  historyCard.anchor = null;
  historyCard.team = '';
}

function scheduleHistoryHide() {
  clearTimeout(historyCard.showTimer);
  clearTimeout(historyCard.hideTimer);
  historyCard.hideTimer = setTimeout(hideHistory, 180);
}

function syncHistoryAnchor() {
  if (!historyCard.team) return;
  const anchor = [...document.querySelectorAll('#standings .history-trigger')]
    .find((button) => button.dataset.team === historyCard.team);
  if (anchor && historyCard.season === state.season
    && state.view === 'standings' && state.standingsView === 'regular') {
    historyCard.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-describedby', 'team-history-summary');
    positionHistory();
  } else hideHistory();
}

$('#standings').addEventListener('pointerover', (event) => {
  const trigger = event.target.closest('.history-trigger');
  if (!trigger || event.pointerType !== 'mouse') return;
  clearTimeout(historyCard.hideTimer);
  if (trigger === historyCard.anchor) return;
  clearTimeout(historyCard.showTimer);
  // A short intent delay avoids spending API budget while the pointer sweeps the table.
  historyCard.showTimer = setTimeout(() => showHistory(trigger), historyCard.anchor ? 80 : 220);
});
$('#standings').addEventListener('pointerout', (event) => {
  const trigger = event.target.closest('.history-trigger');
  if (!trigger || event.pointerType !== 'mouse' || trigger.contains(event.relatedTarget)) return;
  scheduleHistoryHide();
});
$('#standings').addEventListener('focusin', (event) => {
  const trigger = event.target.closest('.history-trigger');
  if (historyCard.suppressFocus) {
    historyCard.suppressFocus = false;
    return;
  }
  if (trigger && trigger.matches(':focus-visible')) showHistory(trigger);
});
$('#standings').addEventListener('focusout', (event) => {
  if (!event.target.closest('.history-trigger')) return;
  if (!event.relatedTarget || !$('#team-history')?.contains(event.relatedTarget)) {
    if (event.relatedTarget?.closest?.('.history-trigger')) return;
    scheduleHistoryHide();
  }
});
$('#standings').addEventListener('click', (event) => {
  const trigger = event.target.closest('.history-trigger');
  if (!trigger) return;
  // Taps and Enter/Space toggle; a mouse click keeps the hover card open.
  if (historyCard.anchor === trigger && !$('#team-history').hidden && historyCard.pointerType !== 'mouse') hideHistory();
  else showHistory(trigger);
  historyCard.pointerType = '';
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !historyCard.anchor) return;
  const anchor = historyCard.anchor;
  hideHistory();
  if (document.activeElement !== anchor) {
    historyCard.suppressFocus = true;
    anchor.focus({ preventScroll: true });
  }
});
document.addEventListener('pointerdown', (event) => {
  historyCard.pointerType = event.pointerType;
  if (!historyCard.anchor || event.target.closest('.history-trigger, #team-history')) return;
  hideHistory();
});
addEventListener('resize', positionHistory);
addEventListener('scroll', positionHistory, { capture: true, passive: true });

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
  const progress = node('div', 'series-progress');
  progress.setAttribute('aria-label', `Series progress: ${series.teams.map((team) => `${team.abbreviation} ${team.wins} wins`).join(', ')}`);
  for (const team of series.teams) {
    const track = node('span', `series-track${team.id === series.winnerId ? ' series-track-winner' : ''}`);
    track.setAttribute('aria-hidden', 'true');
    for (let win = 0; win < Math.ceil(series.bestOf / 2); win += 1) {
      track.append(node('span', win < team.wins ? 'win-dot earned' : 'win-dot'));
    }
    progress.append(track);
  }
  card.append(progress);
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
    const trophy = node('span', 'champion-trophy', '\u{1F3C6}');
    trophy.setAttribute('aria-hidden', 'true');
    champion.append(trophy, teamLogo(bracket.champion), node('div', '', `${bracket.champion.name} \u00b7 NBA Champions`));
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

const playerResponses = new Map();
const players = {
  path: '', loading: false, error: '', sort: { key: 'pts', dir: 'desc' }, expanded: '',
  timer: 0, controller: null, presentation: '',
};
const PLAYER_COLUMNS = [
  ['gp', 'GP', 'Games played'], ['min', 'MIN', 'Minutes per game'], ['pts', 'PTS', 'Points per game'],
  ['reb', 'REB', 'Rebounds per game'], ['ast', 'AST', 'Assists per game'], ['stl', 'STL', 'Steals per game'],
  ['blk', 'BLK', 'Blocks per game'], ['fgPct', 'FG%', 'Field-goal percentage'],
  ['tpPct', '3P%', 'Three-point percentage'], ['ftPct', 'FT%', 'Free-throw percentage'],
];
const LEADERS = [['pts', 'Points', 'PPG'], ['reb', 'Rebounds', 'RPG'], ['ast', 'Assists', 'APG'], ['blk', 'Blocks', 'BPG']];

function playersPath() {
  return state.view === 'favorite' && state.favorite
    ? `/api/players?team=${encodeURIComponent(state.favorite)}&season=${state.season}&phase=${state.phase}` : '';
}

function playerPhoto(player, size = 'small') {
  const initials = player.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('');
  const photo = node('span', `player-photo ${size}`, initials);
  photo.setAttribute('aria-hidden', 'true');
  if (!player.headshot || failedLogos.get(player.headshot) > Date.now()) return photo;
  const image = node('img');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => photo.classList.add('photo-loaded'), { once: true });
  image.addEventListener('error', () => {
    failedLogos.set(player.headshot, Date.now() + 5 * MINUTE);
    image.remove();
  }, { once: true });
  image.src = player.headshot;
  photo.append(image);
  return photo;
}

function statText(stats, key) {
  const value = stats?.[key];
  if (value === undefined || value === null) return '\u2014';
  if (key.endsWith('Pct')) return stats[key.replace('Pct', 'a')] === 0 && key !== 'fgPct' ? '\u2014' : value.toFixed(1);
  return key === 'gp' ? String(value) : value.toFixed(1);
}

function experienceText(years) {
  if (years === null || years === undefined) return '\u2014';
  return years === 0 ? 'Rookie' : `${years} ${years === 1 ? 'season' : 'seasons'}`;
}

function sortedPlayers(list) {
  const { key, dir } = players.sort;
  const direction = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (key === 'name') return direction * a.name.localeCompare(b.name);
    if (key === 'jersey') return direction * ((Number(a.jersey) || 999) - (Number(b.jersey) || 999));
    const left = a.stats?.[key];
    const right = b.stats?.[key];
    // Players without stats always sink to the bottom, whichever direction is chosen.
    if (left === undefined || right === undefined) return (left === undefined) - (right === undefined);
    return direction * (left - right) || a.name.localeCompare(b.name);
  });
}

function countUp(element, value, decimals) {
  element.textContent = value.toFixed(decimals);
  if (!motionEnabled()) return;
  const start = performance.now();
  const step = (time) => {
    const progress = Math.min(1, (time - start) / 700);
    element.textContent = (value * (1 - (1 - progress) ** 3)).toFixed(decimals);
    if (progress < 1 && element.isConnected && motionEnabled()) requestAnimationFrame(step);
    else element.textContent = value.toFixed(decimals);
  };
  requestAnimationFrame(step);
}

function playerDetails(player, id) {
  const panel = node('div', 'player-details');
  panel.id = id;
  const bio = node('dl', 'player-bio');
  const facts = [
    ['Position', player.positionName || player.position || '\u2014'],
    ['Age', player.age ?? '\u2014'],
    ['Height', player.height || '\u2014'],
    ['Weight', player.weight || '\u2014'],
    ['Experience', experienceText(player.experience)],
    ['College', player.college || '\u2014'],
    ['Born', player.birthPlace || '\u2014'],
    ['Status', player.injury ? `${player.injury.status} (injury)` : player.status],
  ];
  for (const [label, value] of facts) {
    const item = node('div');
    item.append(node('dt', '', label), node('dd', '', String(value)));
    bio.append(item);
  }
  panel.append(bio);
  const stats = player.stats;
  if (stats) {
    const shooting = node('div', 'player-shooting');
    for (const [label, made, attempts, pct] of [
      ['Field goals', 'fgm', 'fga', 'fgPct'], ['Three-pointers', 'tpm', 'tpa', 'tpPct'], ['Free throws', 'ftm', 'fta', 'ftPct'],
    ]) {
      const row = node('div', 'shooting-row');
      const meter = node('span', 'shooting-meter');
      const fill = node('span');
      fill.style.setProperty('--pct', `${Math.min(100, stats[pct] || 0)}%`);
      meter.append(fill);
      row.append(node('span', 'shooting-label', label), meter,
        node('span', 'shooting-value', `${statText(stats, made)}\u2013${statText(stats, attempts)} \u00b7 ${statText(stats, pct)}%`));
      shooting.append(row);
    }
    const totals = node('div', 'player-totals');
    for (const [label, value] of [
      ['Total PTS', stats.totalPts], ['Total REB', stats.totalReb], ['Total AST', stats.totalAst],
      ['TOV', stats.tov?.toFixed(1)], ['Fouls', stats.pf?.toFixed(1)], ['Double-doubles', stats.dd], ['Triple-doubles', stats.td],
    ]) {
      const item = node('div', 'total-item');
      item.append(node('strong', '', String(value ?? '\u2014')), node('span', '', label));
      totals.append(item);
    }
    panel.append(shooting, totals);
  } else {
    panel.append(node('p', 'player-empty', state.phase === '1'
      ? 'The data feed does not publish preseason player stats.'
      : 'No games played in this season and phase yet.'));
  }
  const link = node('a', 'player-link', 'Full profile on ESPN \u2197');
  link.href = `https://www.espn.com/nba/player/_/id/${encodeURIComponent(player.id)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  panel.append(link);
  return panel;
}

function renderRoster() {
  const section = $('#roster');
  const path = playersPath();
  section.hidden = !path;
  if (!path) {
    section.replaceChildren();
    return;
  }
  const data = playerResponses.get(path);
  section.setAttribute('aria-busy', String(players.loading && !data));
  const header = node('div', 'roster-header');
  const titles = node('div');
  const heading = node('h2', '', 'The roster');
  heading.id = 'roster-heading';
  const seasonLabel = `${Number(state.season) - 1}\u2013${state.season.slice(-2)}`;
  const phaseLabel = { 1: 'preseason', 2: 'regular-season', 3: 'playoff' }[state.phase];
  titles.append(heading, node('p', 'roster-subtitle',
    `Current roster \u00b7 ${seasonLabel} ${phaseLabel} averages${data?.coach ? ` \u00b7 Head coach ${data.coach}` : ''}`));
  header.append(titles, node('span', 'roster-count', data ? `${data.players.length} PLAYERS` : ''));
  const content = [header];
  const warning = players.error || data?.meta.warning;
  if (warning) content.push(node('p', 'roster-warning', warning));
  if (!data) {
    if (players.loading) {
      const skeleton = node('div', 'roster-skeleton');
      for (let i = 0; i < 6; i += 1) skeleton.append(node('span'));
      content.push(skeleton);
    }
    section.replaceChildren(...content);
    return;
  }
  const withStats = data.players.filter((player) => player.stats?.gp);
  if (withStats.length) {
    const leaders = node('div', 'roster-leaders');
    for (const [key, label, unit] of LEADERS) {
      const leader = withStats.reduce((best, player) => (player.stats[key] > best.stats[key] ? player : best));
      const card = node('button', 'leader-card');
      card.type = 'button';
      card.dataset.player = leader.id;
      card.setAttribute('aria-label', `${label} leader: ${leader.name}, ${leader.stats[key].toFixed(1)} ${unit}. Show details.`);
      const value = node('strong', 'leader-value');
      value.dataset.value = leader.stats[key];
      value.textContent = leader.stats[key].toFixed(1);
      const info = node('span', 'leader-info');
      info.append(node('span', 'eyebrow', `${label.toUpperCase()} LEADER`), node('span', 'leader-name', leader.shortName),
        node('span', 'leader-unit', unit));
      card.append(playerPhoto(leader, 'large'), info, value);
      leaders.append(card);
    }
    content.push(leaders);
  }
  const scroller = node('div', 'roster-scroll');
  scroller.tabIndex = 0;
  scroller.setAttribute('aria-label', 'Roster table, scroll horizontally for more stats');
  const table = node('table', 'roster-table');
  table.append(node('caption', 'sr-only',
    `${data.team.name} roster with ${seasonLabel} ${phaseLabel} per-game averages. Choose a player for details.`));
  const head = node('thead');
  const headings = node('tr');
  for (const [key, label, description] of [['name', 'Player', 'Player name'], ...PLAYER_COLUMNS]) {
    const cell = node('th', key === 'name' ? 'roster-player-head' : '');
    cell.scope = 'col';
    const active = players.sort.key === key;
    if (active) cell.setAttribute('aria-sort', players.sort.dir === 'asc' ? 'ascending' : 'descending');
    const button = node('button', `sort-button${active ? ' active' : ''}`, label);
    button.type = 'button';
    button.dataset.sort = key;
    button.title = `Sort by ${description.toLowerCase()}`;
    if (active) button.append(node('span', 'sort-arrow', players.sort.dir === 'asc' ? '\u25b2' : '\u25bc'));
    cell.append(button);
    headings.append(cell);
  }
  head.append(headings);
  const body = node('tbody');
  for (const player of sortedPlayers(data.players)) {
    const expanded = players.expanded === player.id;
    const row = node('tr', `player-row${expanded ? ' expanded' : ''}${player.injury ? ' injured' : ''}`);
    const nameCell = node('th', 'roster-player');
    nameCell.scope = 'row';
    const toggle = node('button', 'player-toggle');
    toggle.type = 'button';
    toggle.dataset.player = player.id;
    toggle.setAttribute('aria-expanded', String(expanded));
    const detailId = `player-details-${player.id}`;
    toggle.setAttribute('aria-controls', detailId);
    const identity = node('span', 'player-identity');
    identity.append(node('span', 'player-name', player.name),
      node('span', 'player-meta', [player.jersey && `#${player.jersey}`, player.position].filter(Boolean).join(' \u00b7 ')));
    toggle.append(playerPhoto(player), identity);
    if (player.injury) {
      const badge = node('span', 'injury-badge', player.injury.status);
      badge.title = `Injury status: ${player.injury.status}`;
      toggle.append(badge);
    }
    nameCell.append(toggle);
    row.append(nameCell);
    for (const [key] of PLAYER_COLUMNS) {
      row.append(node('td', players.sort.key === key ? 'sorted' : '', statText(player.stats, key)));
    }
    body.append(row);
    if (expanded) {
      const detailRow = node('tr', 'player-detail-row');
      const cell = node('td');
      cell.colSpan = PLAYER_COLUMNS.length + 1;
      cell.append(playerDetails(player, detailId));
      detailRow.append(cell);
      body.append(detailRow);
    }
  }
  table.append(head, body);
  scroller.append(table);
  content.push(scroller,
    node('p', 'roster-source', `Stats: per game \u00b7 one shared league-wide request covers every team \u00b7 Updated ${timeFormatter.format(new Date(data.meta.fetchedAt))}`));
  const focused = document.activeElement?.closest?.('#roster [data-player], #roster [data-sort]');
  // Re-rendering replaces nodes; keep keyboard focus on the equivalent control.
  const focusKey = focused && (focused.dataset.sort ? `[data-sort="${focused.dataset.sort}"]`
    : `${focused.classList.contains('leader-card') ? '.leader-card' : '.player-toggle'}[data-player="${focused.dataset.player}"]`);
  section.replaceChildren(...content);
  if (focusKey) section.querySelector(focusKey)?.focus({ preventScroll: true });
  animateRoster(path);
}

function animateRoster(path) {
  if (players.presentation === path) return;
  players.presentation = path;
  rosterObserver?.disconnect();
  const section = $('#roster');
  section.querySelectorAll('.leader-value').forEach((value) => countUp(value, Number(value.dataset.value), 1));
  if (!motionEnabled()) return;
  const items = [...section.querySelectorAll('.leader-card, .player-row')];
  rosterObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      if (!motionEnabled()) continue;
      entry.target.animate([
        { opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 420, delay: (items.indexOf(entry.target) % 10) * 40, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
    }
  }, { threshold: 0.05 });
  items.forEach((item) => rosterObserver.observe(item));
}

async function loadPlayers() {
  clearTimeout(players.timer);
  const path = playersPath();
  if (path !== players.path) {
    players.controller?.abort();
    players.loading = false;
    players.error = '';
    players.expanded = '';
    players.presentation = '';
    players.path = path;
  }
  if (!path || players.loading) {
    renderRoster();
    return;
  }
  const cached = playerResponses.get(path);
  const schedule = (at) => {
    if (!document.hidden) players.timer = setTimeout(loadPlayers, Math.min(2_147_000_000, Math.max(15_000, at - Date.now())));
  };
  if (cached && !cached.meta.stale && cached.meta.expiresAt > Date.now()) {
    renderRoster();
    schedule(cached.meta.nextRefreshAt);
    return;
  }
  players.loading = true;
  renderRoster();
  players.controller = new AbortController();
  try {
    const result = await api(path, players.controller.signal);
    if (players.path !== path) return;
    playerResponses.delete(path);
    playerResponses.set(path, result);
    while (playerResponses.size > 12) playerResponses.delete(playerResponses.keys().next().value);
    players.error = '';
    renderUsage(result.meta.usage);
    schedule(result.meta.nextRefreshAt);
  } catch (error) {
    if (error.name === 'AbortError' || players.path !== path) return;
    console.error('Unable to load the roster:', error);
    players.error = `${error.message} We will retry automatically.`;
    schedule(Math.max(error.retryAt || 0, Date.now() + MINUTE));
  } finally {
    if (players.path === path) {
      players.loading = false;
      renderRoster();
    }
  }
}

$('#roster').addEventListener('click', (event) => {
  const sort = event.target.closest('[data-sort]');
  if (sort) {
    const key = sort.dataset.sort;
    players.sort = players.sort.key === key
      ? { key, dir: players.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' };
    renderRoster();
    return;
  }
  const target = event.target.closest('[data-player]');
  if (!target) return;
  const leader = target.classList.contains('leader-card');
  players.expanded = players.expanded === target.dataset.player && !leader ? '' : target.dataset.player;
  renderRoster();
  if (leader) {
    const row = $(`#roster .player-toggle[data-player="${target.dataset.player}"]`);
    row?.focus({ preventScroll: true });
    row?.closest('tr').scrollIntoView({ block: 'center', behavior: motionEnabled() ? 'smooth' : 'auto' });
  }
});

function renderGames() {
  renderContent();
  animateContent();
}

function renderContent() {
  const grid = $('#games');
  const standings = state.view === 'standings';
  const playoffs = standings && state.standingsView === 'playoffs';
  if (!standings || playoffs) hideHistory();
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
  void loadPlayers();
  const requestId = ++state.requestId;
  const path = pathForView();
  state.error = '';
  state.retryAt = 0;
  state.loading = false;
  state.scoreChanges = new Set();
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
    if (cached?.games && result.games && !result.meta.stale) {
      const previous = new Map(cached.games.map((game) => [game.id, game]));
      for (const game of result.games) {
        const old = previous.get(game.id);
        if (!old || old.state === 'scheduled' || game.state === 'scheduled') continue;
        for (const side of ['home', 'away']) {
          if (game[side].score !== null && old[side].score !== null
            && game[side].score !== old[side].score) {
            state.scoreChanges.add(`${game.id}:${game[side].id}`);
          }
        }
      }
    }
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
  document.body.classList.toggle('page-hidden', document.hidden);
  if (document.hidden) {
    clearTimeout(timer);
    clearTimeout(players.timer);
    requestController?.abort();
    document.getAnimations().forEach((animation) => animation.pause());
  } else {
    if (motionEnabled()) document.getAnimations().forEach((animation) => animation.play());
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
  revealObserver?.disconnect();
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
