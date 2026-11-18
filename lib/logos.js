import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data.js';

const ABBREVIATIONS = new Set([
  'atl', 'bos', 'bkn', 'cha', 'chi', 'cle', 'dal', 'den', 'det', 'gs',
  'hou', 'ind', 'lac', 'lal', 'mem', 'mia', 'mil', 'min', 'no', 'ny',
  'okc', 'orl', 'phi', 'phx', 'por', 'sac', 'sa', 'tor', 'utah', 'wsh',
]);
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Static CDN images: deduplicated, disk-persisted, and outside the sports-data API budget.
class ImageCache {
  constructor({ cacheDirectory, fetcher = fetch, now = Date.now, logger = console } = {}, options) {
    this.cacheDirectory = cacheDirectory;
    this.fetcher = fetcher;
    this.now = now;
    this.logger = logger;
    this.options = options;
    this.entries = new Map();
    this.inflight = new Map();
    this.failures = new Map();
  }

  async load(abbreviation) {
    if (!this.options.accepts(abbreviation)) throw new DataError(this.options.unknown, 404);
    const entry = this.entries.get(abbreviation);
    if (entry && entry.expiresAt > this.now()) return entry.body;
    if (this.inflight.has(abbreviation)) return this.inflight.get(abbreviation);
    const pending = this.refresh(abbreviation, entry);
    this.inflight.set(abbreviation, pending);
    try {
      return await pending;
    } finally {
      this.inflight.delete(abbreviation);
    }
  }

  async refresh(abbreviation, previous) {
    const file = this.cacheDirectory && join(this.cacheDirectory, `${abbreviation}.png`);
    if (!previous && file) {
      try {
        const [body, info] = await Promise.all([readFile(file), stat(file)]);
        if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) {
          throw new Error(`Invalid cached team logo: ${file}`);
        }
        previous = { body, expiresAt: info.mtimeMs + this.options.ttl };
        this.remember(abbreviation, previous);
        if (previous.expiresAt > this.now()) return body;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const failure = this.failures.get(abbreviation);
    if (failure?.retryAt > this.now()) {
      if (previous) return previous.body;
      throw new DataError(failure.message, 503, failure.retryAt);
    }
    let body;
    try {
      const response = await this.fetcher(this.options.url(abbreviation),
        { signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) {
        const error = new Error('Image provider returned HTTP 404.');
        error.missing = true;
        throw error;
      }
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
        throw new Error(`Image provider returned HTTP ${response.status} or a non-PNG response.`);
      }
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > 1_000_000 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Image provider returned an invalid image.');
      }
    } catch (error) {
      const message = this.options.unavailable(abbreviation);
      // Missing photos will not appear soon; do not re-ask the CDN on every render.
      const retryAt = this.now() + (error.missing ? DAY : 5 * 60_000);
      this.logger.error(message, error.message);
      this.failures.set(abbreviation, { message, retryAt });
      if (previous) return previous.body;
      throw new DataError(message, 503, retryAt);
    }
    if (file) {
      await mkdir(this.cacheDirectory, { recursive: true });
      await writeFile(`${file}.tmp`, body, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    }
    this.remember(abbreviation, { body, expiresAt: this.now() + this.options.ttl });
    this.failures.delete(abbreviation);
    return body;
  }

  remember(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.options.memoryLimit) this.entries.delete(this.entries.keys().next().value);
  }
}

export class TeamLogos extends ImageCache {
  constructor(settings) {
    super(settings, {
      accepts: (key) => ABBREVIATIONS.has(key),
      url: (key) => `https://a.espncdn.com/i/teamlogos/nba/500/${key}.png`,
      unknown: 'Unknown NBA team logo.',
      unavailable: (key) => `Team logo unavailable for ${key.toUpperCase()}.`,
      ttl: WEEK,
      memoryLimit: 30,
    });
  }
}

export class PlayerHeadshots extends ImageCache {
  constructor(settings) {
    super(settings, {
      accepts: (key) => /^[1-9]\d{0,9}$/.test(key),
      // The CDN resizer returns ~10 KB images instead of ~240 KB originals.
      url: (key) => `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${key}.png&w=160&h=116&scale=crop`,
      unknown: 'Unknown NBA player photo.',
      unavailable: () => 'Player photo unavailable.',
      ttl: 30 * DAY,
      memoryLimit: 300,
    });
  }
}
