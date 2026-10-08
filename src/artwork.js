import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { normKey, similarity } from './parse.js';

// Wikimedia asks API clients to identify themselves with a name and a contact URL.
const { version } = createRequire(import.meta.url)('../package.json');
const USER_AGENT = `Shoebox/${version} (https://github.com/theanam/shoebox-streamer)`;

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': USER_AGENT } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
}

const strip = (html) => (html || '').replace(/<[^>]+>/g, '').trim() || undefined;

/**
 * Fetches poster art from keyless public APIs (TVMaze for shows, Wikipedia for movies) and
 * TMDB when an API key is provided. Results, including misses, are cached in <cacheDir>/art.
 */
export class Artwork {
  constructor(cacheDir, { offline = false, tmdbKey, log = () => {} } = {}) {
    this.dir = path.join(cacheDir, 'art');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    this.offline = offline;
    this.tmdbKey = tmdbKey;
    this.log = log;
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.index = {};
    }
    this.queue = [];
    this.active = 0;
    this.inflight = new Set();
  }

  get pending() {
    return this.queue.length + this.active;
  }

  /** @returns {{ file?: string, overview?: string } | undefined} */
  get(key) {
    const e = this.index[key];
    return e && e.file ? e : undefined;
  }
  url(key) {
    const e = this.get(key);
    return e ? `/art/${e.file}` : null;
  }
  filePath(name) {
    if (!/^[a-f0-9]{16}\.jpg$/.test(name)) return null;
    return path.join(this.dir, name);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => fsp.writeFile(this.indexFile, JSON.stringify(this.index)).catch(() => {}), 500);
  }

  enqueue(key, fn, onDone) {
    const e = this.index[key];
    const fresh = e && (e.file || Date.now() - e.miss < 7 * 86400_000);
    if (this.offline || fresh || this.inflight.has(key)) return;
    this.inflight.add(key);
    this.queue.push(async () => {
      try {
        const r = await fn();
        if (r?.image) {
          const file = hash(key) + '.jpg';
          await download(r.image, path.join(this.dir, file));
          this.index[key] = { file, overview: r.overview };
        } else this.index[key] = { miss: Date.now() };
        this.save();
        onDone?.();
      } catch (e) {
        this.log(`artwork lookup failed for ${key}: ${e.message}`);
      } finally {
        this.inflight.delete(key);
      }
    });
    this.pump();
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      job().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  static showKey(show) {
    return 'show:' + show.key;
  }
  static movieKey(item) {
    return 'movie:' + (item.title || '').toLowerCase() + ':' + (item.parsed.year || '');
  }

  enqueueShow(show, onDone) {
    this.enqueue(Artwork.showKey(show), () => this.lookupShow(show.name), onDone);
  }
  enqueueMovie(item, onDone) {
    if (!item.title) return;
    this.enqueue(Artwork.movieKey(item), () => this.lookupMovie(item.title, item.parsed.year), onDone);
  }

  async lookupShow(name) {
    if (this.tmdbKey) {
      const r = await this.tmdb('tv', name);
      if (r) return r;
    }
    const list = (await getJSON(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`)) || [];
    // Only accept a close name match; a wrong poster is worse than a video frame.
    const want = normKey(name);
    const hit = list.map((r) => r.show).find((s) => s?.image && similarity(normKey(s.name), want) >= 0.85);
    if (hit) return { image: hit.image.original || hit.image.medium, overview: strip(hit.summary) };
    return null;
  }

  async lookupMovie(title, year) {
    if (this.tmdbKey) {
      const r = await this.tmdb('movie', title, year);
      if (r) return r;
    }
    // Wikipedia: a film article's lead image is almost always its poster.
    const q = `${title}${year ? ' ' + year : ''} film`;
    const j = await getJSON(
      'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrlimit=3' +
        '&prop=pageimages|extracts&piprop=thumbnail&pithumbsize=600&pilicense=any&exintro=1&explaintext=1&exsentences=3' +
        `&gsrsearch=${encodeURIComponent(q)}`
    );
    const pages = Object.values(j?.query?.pages || {}).sort((a, b) => a.index - b.index);
    const want = normKey(title);
    const hit = pages.find((p) => {
      if (!p.thumbnail?.source) return false;
      const name = normKey(p.title.replace(/\s*\([^)]*\)\s*$/, ''));
      if (similarity(name, want) < 0.8) return false;
      const text = p.extract || '';
      if (!/\bfilm\b|\bmovie\b/i.test(text)) return false;
      if (!year) return true;
      // Matching year (±1 for festival vs. release dates) wins. With no year in the summary, only an
      // exact title is trusted; a summary naming a different year is another film ("Hero" 2002 vs 2018).
      const years = (text.match(/\b(?:19|20)\d\d\b/g) || []).map(Number);
      if (years.some((y) => Math.abs(y - year) <= 1)) return true;
      return !years.length && name === want;
    });
    if (hit) return { image: hit.thumbnail.source, overview: hit.extract };
    return null;
  }

  async tmdb(kind, query, year) {
    try {
      const yr = year ? (kind === 'tv' ? `&first_air_date_year=${year}` : `&year=${year}`) : '';
      const j = await getJSON(
        `https://api.themoviedb.org/3/search/${kind}?api_key=${this.tmdbKey}&query=${encodeURIComponent(query)}${yr}`
      );
      const r = j?.results?.find((x) => x.poster_path);
      if (r) return { image: `https://image.tmdb.org/t/p/w500${r.poster_path}`, overview: r.overview };
    } catch (e) {
      this.log(`TMDB lookup failed: ${e.message}`);
    }
    return null;
  }
}
