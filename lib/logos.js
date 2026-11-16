import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data.js';

const ABBREVIATIONS = new Set([
  'atl', 'bos', 'bkn', 'cha', 'chi', 'cle', 'dal', 'den', 'det', 'gs',
  'hou', 'ind', 'lac', 'lal', 'mem', 'mia', 'mil', 'min', 'no', 'ny',
  'okc', 'orl', 'phi', 'phx', 'por', 'sac', 'sa', 'tor', 'utah', 'wsh',
]);
const WEEK = 7 * 86_400_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class TeamLogos {
  constructor({ cacheDirectory, fetcher = fetch, now = Date.now, logger = console } = {}) {
    this.cacheDirectory = cacheDirectory;
    this.fetcher = fetcher;
    this.now = now;
    this.logger = logger;
    this.entries = new Map();
    this.inflight = new Map();
    this.failures = new Map();
  }

  async load(abbreviation) {
    if (!ABBREVIATIONS.has(abbreviation)) throw new DataError('Unknown NBA team logo.', 404);
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
        previous = { body, expiresAt: info.mtimeMs + WEEK };
        this.entries.set(abbreviation, previous);
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
      const response = await this.fetcher(
        `https://a.espncdn.com/i/teamlogos/nba/500/${abbreviation}.png`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
        throw new Error(`Logo provider returned HTTP ${response.status} or a non-PNG response.`);
      }
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > 1_000_000 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Logo provider returned an invalid image.');
      }
    } catch (error) {
      const message = `Team logo unavailable for ${abbreviation.toUpperCase()}.`;
      const retryAt = this.now() + 5 * 60_000;
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
    this.entries.set(abbreviation, { body, expiresAt: this.now() + WEEK });
    this.failures.delete(abbreviation);
    return body;
  }
}
