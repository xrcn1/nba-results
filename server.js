import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DataError, NbaData, nbaDate } from './lib/data.js';
import { TeamLogos } from './lib/logos.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createApp(data, logos = new TeamLogos({ cacheDirectory: resolve(root, '.cache', 'logos') })) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new DataError('Method not allowed.', 405);
      }
      const logoMatch = /^\/logos\/([a-z]+)\.png$/.exec(url.pathname);
      if (logoMatch) {
        const body = await logos.load(logoMatch[1]);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'Content-Length': body.length,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      let result;
      if (url.pathname === '/api/teams') result = await data.teams();
      else if (url.pathname === '/api/scores') {
        result = await data.scoreboard(url.searchParams.get('date') || nbaDate());
      } else if (url.pathname === '/api/schedule') {
        result = await data.schedule(url.searchParams.get('team') || '', url.searchParams.get('season') || '',
          url.searchParams.get('phase') || '2');
      } else if (url.pathname === '/api/standings') {
        result = await data.standings(url.searchParams.get('season') || '');
      } else if (url.pathname === '/api/playoffs') {
        result = await data.playoffs(url.searchParams.get('season') || '');
      } else if (url.pathname === '/api/usage') result = data.usage();
      else {
        const asset = assets.get(url.pathname);
        if (!asset) throw new DataError('Not found.', 404);
        const body = await readFile(resolve(root, 'public', asset[0]));
        res.writeHead(200, {
          'Content-Type': asset[1],
          'Cache-Control': 'no-cache',
          'Content-Length': body.length,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result));
    } catch (error) {
      const expected = error instanceof DataError;
      if (!expected) console.error('Request failed:', error);
      const retryAt = expected ? error.retryAt : Date.now() + 60_000;
      if (retryAt) res.setHeader('Retry-After', Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
      res.writeHead(expected ? error.status : 500, {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
        error: expected ? error.message : 'The local server could not complete the request. Check the terminal.',
        retryAt,
      }));
    }
  });
}

function positiveInt(value, fallback, name, maximum) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return Number(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = positiveInt(process.env.PORT, 3000, 'PORT', 65535);
  const data = new NbaData({
    cacheFile: resolve(root, '.cache', 'nba.json'),
    dailyLimit: positiveInt(process.env.NBA_DAILY_LIMIT, 300, 'NBA_DAILY_LIMIT', 10000),
    minuteLimit: positiveInt(process.env.NBA_MINUTE_LIMIT, 4, 'NBA_MINUTE_LIMIT', 4),
  });
  const server = createApp(data);
  server.on('error', (error) => {
    console.error(`Cannot start Courtside: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Courtside is ready at http://127.0.0.1:${port}`);
    console.log('Local access only. NBA API safety budget:', data.dailyLimit, 'requests/day.');
  });
}
