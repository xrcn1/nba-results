# Courtside

A lightweight NBA web app for your local browser: automatically updated scores,
date-by-date games, team schedules, results, and a favorite team saved on your device.
Includes preseason, regular-season, and postseason schedule filters.
Recognizable team logos appear in game cards, your favorite banner, and standings.
The **Standings** tab separates Eastern and Western Conferences, showing each
team's conference rank, wins (W), losses (L), and winning percentage (PCT).
PCT uses the NBA convention (`.750` means 75%). Rankings follow the provider's
conference seed, including its tie-break ordering when available.
Inside **Standings**, switch to **Playoffs** for the selected season's full bracket:
East/West first rounds, conference semifinals, conference finals, and NBA Finals.
Series cards show team logos, series wins, the leader/winner, and live status.
The champion appears once the Finals are won. Confirmed later-round cards list
the preceding matchups; unknown teams remain **TBD**, never projected from current
standings. Play-in games are excluded. Before the postseason is announced, choose
a previous season (for example 2025–26) to see a completed bracket.

## Run

Requires **Node.js 22 or newer**. No packages, API keys, accounts, or build step.

```sh
npm start
```

Open **http://127.0.0.1:3000**. Keep the terminal running; press Ctrl+C to stop.
If the port is occupied: `PORT=3001 npm start`.
The server binds only to your machine, not your Wi-Fi network.

Choose a favorite in the sidebar, then open **My team** for the last four results
and next six games. The Results, Live, and Upcoming filters show all matching games
in the selected season/phase. **Team schedule** shows the full provider-returned schedule.
Season labels use the ending year: 2026–27 corresponds to `2027`.
Standings use the same season selector and always show regular-season records,
independent of the schedule's preseason/postseason phase.

Game-day navigation uses **US Eastern Time**, as the provider does, so late-night
games stay together. Tip-off times and update timestamps use your browser's local time zone.
Scheduled games show a dash rather than a misleading 0–0 result. “Live” is polled,
not a real-time streaming service. ESPN may delay, reschedule, or omit games.

## Free data sources checked

Checked November 17, 2026:

| Source | Free access | Limits / tradeoffs |
| --- | --- | --- |
| [ESPN public scoreboard](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard), team schedules, and [standings](https://site.api.espn.com/apis/v2/sports/basketball/nba/standings) | Works without a key; used by this app | Unofficial, undocumented public feed; no published guaranteed quota or service availability. May change or block access. Not a licensed redistribution service. |
| [BALLDONTLIE NBA](https://docs.balldontlie.io/) | Teams, players, and games on the free tier; requires an account/key | Documented **5 requests/minute** on the free tier; many stats require paid tiers. Not integrated. |

This app does not use a paid API or consume purchased credits. ESPN's public
availability is not a promise of unlimited access or permission for commercial use.
Use this as a personal local viewer; review provider terms before publishing or redistributing.
There is deliberately **no automatic provider fallback**, scraping, or retry loop that
could quietly spend someone else's quota. Data failures are visible in the interface.

## Request protection

- One shared backend cache across dates, teams, users of the local server, and tabs.
- Concurrent requests for the same resource collapse into one provider request.
- Browser-side reuse avoids even local HTTP calls when data is still fresh.
- Live games and games within 30 minutes of tip-off: **2-minute cache**.
- Today's idle scoreboard: **15 minutes**; completed slate: **6 hours**.
- Historical days: **24 hours**; future dates: **up to 6 hours**, shortened to
  recheck before tip-off so a long-lived cache cannot hide the start of a game.
- Team schedules: **15 minutes**, or **2 minutes** while live/near tip-off.
- Team directory: **7 days**.
- Standings: **30 minutes**, fetching both conferences in one shared request,
  only when the Standings tab is in use. Uses the same budget and stale/error handling.
- Playoffs: **one annual scoreboard request** per selected season, explicitly
  filtered to that season's postseason (ESPN ignores the scoreboard's `seasontype`
  filter). No per-team or per-series API requests. Cached for **2 minutes while
  live**, **15 minutes during an announced postseason**, **6 hours before matchups
  exist**, and **24 hours after the champion is known**, using the same shared cap,
  deduplication, disk persistence, cooldowns, and visible stale-data warnings.
- Team logos are served locally from ESPN's static image CDN, with a **7-day
  shared memory/disk cache** and **7-day browser caching**. Downloads are deduplicated,
  persist across restarts, and do not consume sports-data API calls. Only the 30
  known NBA team paths are allowed. Failures pause image retries for five minutes.
  If an image cannot load, the team abbreviation remains visible with an explanatory tooltip.
- Hard shared cap: **4 upstream requests per rolling minute**, **300 per UTC day**.
  These are our safety limits, not claims about ESPN's quota.
- Requests, including failed requests, count against the budget. Fresh cache reads do not.
- Cache and budget persist in `.cache/nba.json`, including recent requests and cooldowns.
  Restarting the server does not reset them. Run one server instance per directory;
  the JSON cache is not a multi-process database.
- Provider errors trigger exponential cooldowns (30 seconds to 30 minutes);
  `Retry-After` seconds or HTTP dates are respected even when longer.
- Stale cached data remains visible with an explicit warning and original fetch timestamp.
  Without cached data, errors are shown, never fake scores or a success-shaped empty slate.
- No background provider work when nobody is using the app. Hidden tabs stop polling.
  An already-started server request may finish and populate the shared cache.
- The footer shows daily upstream usage. Rapidly browsing uncached dates can hit the
  minute cap; the app waits rather than exceeding it. Exhausting the daily cap pauses
  new provider requests until midnight UTC.

Lower the budget if desired (shell environment variables):

```sh
NBA_DAILY_LIMIT=150 NBA_MINUTE_LIMIT=2 npm start
```

`NBA_DAILY_LIMIT` accepts 1–10000 (default 300); `NBA_MINUTE_LIMIT` accepts 1–4 (default 4).
Raising the daily budget does not bypass provider throttling. Deleting the cache
also deletes the saved budget, so do not do that to evade limits. If the cache is
corrupt, startup explicitly fails instead of silently resetting usage.

## Implementation and checks

Node.js's built-in HTTP server and `fetch`, a small JSON disk cache, and vanilla
HTML/CSS/JavaScript. No framework bundle, external fonts, build tooling,
runtime dependencies, analytics, or automatic third-party browser requests.
The local server retrieves and caches team images from `https://a.espncdn.com`.
JavaScript is a practical efficient choice for this small I/O-bound
app: one runtime, asynchronous network I/O, and very little operational overhead.
Caching and request scheduling matter more here than CPU-heavy language optimizations.

```sh
npm run check
npm test
```

Tests use Node's built-in test runner and mocked provider responses: exact cache
lifetimes, in-flight deduplication, rolling and daily limits, UTC reset,
429/backoff handling, stale/error behavior, persistence, normalization, query
validation, standings conference/rank/stat handling and cache limits, logo URL
coverage for all 30 teams, and local HTTP routing. They consume **zero provider requests**.
