// Online subtitle search & download: OpenSubtitles.com (exact matches via file hash) and SubDL.
// Local subtitles (embedded tracks, files next to the video) always win; these are only used
// when nothing local exists in one of the preferred languages.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { similarity } from './parse.js';
import { toIso1, languageName } from './lang.js';

const { version } = createRequire(import.meta.url)('../package.json');
const UA = `Shoebox v${version}`;
const TIMEOUT = 15000;

// ------------------------------------------------------------------ helpers

/** OpenSubtitles hash: file size + 64-bit little-endian sums of the first and last 64 KiB. */
export async function openSubtitlesHash(file) {
  const CHUNK = 65536;
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < CHUNK * 2) return null;
    let sum = BigInt(size);
    const buf = Buffer.alloc(CHUNK);
    for (const pos of [0, size - CHUNK]) {
      await fh.read(buf, 0, CHUNK, pos);
      for (let i = 0; i < CHUNK; i += 8) sum += buf.readBigUInt64LE(i);
    }
    return (sum & 0xffffffffffffffffn).toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

/** Decode subtitle bytes: UTF-8 (with or without BOM / UTF-16 BOM), falling back to Windows-1252. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Minimal zip reader (stored + deflate), enough for subtitle archives. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue;
    out.push({ name, data });
  }
  return out;
}

const SUB_FILE = /\.(srt|vtt|ass|ssa)$/i;

/** Lower-case alphanumeric tokens of a release/file name, for similarity scoring. */
function releaseKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.(srt|vtt|ass|ssa|mkv|mp4|avi|m4v|webm|zip)$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ------------------------------------------------------------------ providers

export class OpenSubtitles {
  constructor({ apiKey, username, password, log = () => {} }) {
    this.name = 'opensubtitles';
    this.label = 'OpenSubtitles';
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;
    this.log = log;
    this.base = 'https://api.opensubtitles.com/api/v1';
    this.token = null;
    this.tokenAt = 0;
    this.exhaustedUntil = 0;
  }

  headers(extra = {}) {
    const h = { 'Api-Key': this.apiKey, 'User-Agent': UA, Accept: 'application/json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async login() {
    if (!this.username || !this.password) return null;
    if (this.token && Date.now() - this.tokenAt < 12 * 3600_000) return this.token;
    const r = await fetchJSON(`${this.base}/login`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    this.token = r.token;
    this.tokenAt = Date.now();
    if (r.base_url) this.base = `https://${r.base_url.replace(/^https?:\/\//, '')}/api/v1`;
    return r;
  }

  /** Check the key (and login, when configured). Returns a human-readable status line. */
  async test() {
    await fetchJSON(`${this.base}/infos/formats`, { headers: this.headers() });
    if (this.username) {
      const r = await this.login();
      const allowed = r?.user?.allowed_downloads;
      return `API key OK, logged in as ${this.username}${allowed ? ` (${allowed} downloads/day)` : ''}`;
    }
    return 'API key OK (add a username/password to raise the daily download limit)';
  }

  async search(item, { languages, hash }) {
    const p = item.parsed;
    const params = { languages: languages.join(',') };
    if (hash) params.moviehash = hash;
    if (item.kind === 'episode') {
      params.query = (item.showName || p.show || '').toLowerCase();
      params.season_number = String(p.season ?? 1);
      params.episode_number = String(p.episode ?? 1);
      params.type = 'episode';
    } else {
      params.query = (item.title || '').toLowerCase();
      if (p.year) params.year = String(p.year);
      params.type = 'movie';
    }
    // The API asks for alphabetically sorted parameters (otherwise it redirects).
    const qs = new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
    const r = await fetchJSON(`${this.base}/subtitles?${qs}`, { headers: this.headers() });
    const out = [];
    for (const d of r.data || []) {
      const a = d.attributes || {};
      const file = a.files?.[0];
      if (!file?.file_id) continue;
      const fd = a.feature_details || {};
      out.push({
        provider: this.name,
        providerLabel: this.label,
        ref: String(file.file_id),
        release: a.release || file.file_name || '',
        fileName: file.file_name,
        lang: toIso1(a.language) || a.language,
        hashMatch: !!a.moviehash_match,
        hi: !!a.hearing_impaired,
        machine: !!(a.machine_translated || a.ai_translated),
        downloads: a.download_count || 0,
        season: fd.season_number,
        episode: fd.episode_number,
      });
    }
    return out;
  }

  async download(c) {
    if (Date.now() < this.exhaustedUntil) throw Object.assign(new Error('OpenSubtitles daily download limit reached'), { quota: true });
    try {
      await this.login();
    } catch (e) {
      this.log(`OpenSubtitles login failed: ${e.message}`);
    }
    let r;
    try {
      r = await fetchJSON(`${this.base}/download`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ file_id: Number(c.ref), sub_format: 'srt' }),
      });
    } catch (e) {
      if (e.status === 406 || e.status === 429) {
        const reset = Date.parse(e.body?.reset_time_utc || '') || Date.now() + 3600_000;
        this.exhaustedUntil = reset;
        throw Object.assign(new Error(`OpenSubtitles download limit reached (resets ${new Date(reset).toLocaleString()})`), { quota: true });
      }
      throw e;
    }
    if (!r.link) throw new Error(r.message || 'no download link');
    const res = await fetch(r.link, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return { text: decodeText(Buffer.from(await res.arrayBuffer())), ext: '.srt', remaining: r.remaining };
  }
}

export class SubDL {
  constructor({ apiKey, log = () => {} }) {
    this.name = 'subdl';
    this.label = 'SubDL';
    this.apiKey = apiKey;
    this.log = log;
  }

  url(params) {
    const qs = new URLSearchParams({ api_key: this.apiKey, ...params });
    return `https://api.subdl.com/api/v1/subtitles?${qs}`;
  }

  get headers() {
    return { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': UA, Accept: 'application/json' };
  }

  async test() {
    const r = await fetchJSON(this.url({ film_name: 'Inception', type: 'movie', languages: 'EN', subs_per_page: '1' }), { headers: this.headers });
    if (r.status === false) throw new Error(r.error || 'rejected');
    return 'API key OK';
  }

  async search(item, { languages }) {
    const p = item.parsed;
    const params = {
      languages: languages.map((l) => l.toUpperCase()).join(','),
      subs_per_page: '30',
    };
    if (item.kind === 'episode') {
      params.film_name = item.showName || p.show || '';
      params.type = 'tv';
      params.season_number = String(p.season ?? 1);
      params.episode_number = String(p.episode ?? 1);
    } else {
      params.film_name = item.title || '';
      params.type = 'movie';
      if (p.year) params.year = String(p.year);
    }
    params.file_name = path.basename(item.rel);
    const r = await fetchJSON(this.url(params), { headers: this.headers });
    if (r.status === false) {
      if (/not found|no subtitles/i.test(r.error || '')) return [];
      throw new Error(r.error || 'search failed');
    }
    return (r.subtitles || [])
      .filter((s) => s.url)
      .map((s) => ({
        provider: this.name,
        providerLabel: this.label,
        ref: s.url,
        release: s.release_name || s.name || '',
        lang: toIso1(s.lang) || toIso1(s.language) || String(s.language || s.lang || '').toLowerCase(),
        hashMatch: false,
        hi: !!s.hi,
        machine: false,
        downloads: 0,
        season: s.season ?? undefined,
        episode: s.episode ?? undefined,
        fullSeason: !!s.full_season,
      }));
  }

  async download(c, item) {
    const url = /^https?:/.test(c.ref) ? c.ref : `https://dl.subdl.com${c.ref.startsWith('/') ? '' : '/'}${c.ref}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let files;
    try {
      files = unzip(buf).filter((f) => SUB_FILE.test(f.name));
    } catch {
      files = [{ name: 'subtitle.srt', data: buf }];
    }
    if (!files.length) throw new Error('archive contains no subtitle files');
    const pick = pickArchiveEntry(files, item);
    return { text: decodeText(pick.data), ext: path.extname(pick.name).toLowerCase() || '.srt' };
  }
}

/** For season packs, choose the file for this episode; otherwise the one most like the video's name. */
export function pickArchiveEntry(files, item) {
  if (files.length === 1) return files[0];
  const p = item.parsed || {};
  if (item.kind === 'episode' && p.episode != null) {
    const s = p.season ?? 1;
    const e = p.episode;
    const re = new RegExp(`(?:s0*${s}[ ._-]*e0*${e}(?!\\d))|(?:\\b0*${s}x0*${e}(?!\\d))|(?:e[p]?0*${e}(?!\\d))`, 'i');
    const hit = files.find((f) => re.test(path.basename(f.name)));
    if (hit) return hit;
  }
  const want = releaseKey(path.basename(item.rel));
  return [...files].sort((a, b) => similarity(releaseKey(path.basename(b.name)), want) - similarity(releaseKey(path.basename(a.name)), want))[0];
}

// ------------------------------------------------------------------ ranking

export function rank(candidates, item, languages) {
  const want = releaseKey(path.basename(item.rel));
  const p = item.parsed || {};
  const scored = [];
  for (const c of candidates) {
    const li = languages.indexOf(c.lang);
    if (li < 0) continue;
    if (item.kind === 'episode') {
      if (c.season != null && p.season != null && Number(c.season) !== Number(p.season)) continue;
      if (c.episode != null && p.episode != null && Number(c.episode) !== Number(p.episode) && !c.fullSeason) continue;
    }
    let score = 0;
    if (c.hashMatch) score += 1000;
    score += similarity(releaseKey(c.release), want) * 300;
    score += (languages.length - li) * 60;
    if (c.machine) score -= 250;
    if (c.hi) score -= 25;
    if (c.fullSeason) score -= 40;
    score += Math.log10((c.downloads || 0) + 1) * 12;
    scored.push({ ...c, score: Math.round(score) });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------ service

export class SubtitleService {
  constructor({ config, library, log = () => {}, offline = false }) {
    this.library = library;
    this.log = log;
    const sc = config.subtitles;
    this.languages = sc.languages.map((l) => toIso1(l) || l);
    this.autoDownload = sc.autoDownload;
    this.providers = [];
    if (!offline) {
      if (sc.openSubtitles.apiKey) this.providers.push(new OpenSubtitles({ ...sc.openSubtitles, log }));
      if (sc.subdl.apiKey) this.providers.push(new SubDL({ apiKey: sc.subdl.apiKey, log }));
    }
    this.indexFile = path.join(library.cacheDir, 'subtitle-searches.json');
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.index = {};
    }
    this.inflight = new Map();
  }

  get enabled() {
    return this.providers.length > 0;
  }

  publicInfo() {
    return {
      providers: this.providers.map((p) => p.label),
      languages: this.languages,
      autoDownload: this.enabled && this.autoDownload,
    };
  }

  saveIndex() {
    fsp.writeFile(this.indexFile, JSON.stringify(this.index)).catch(() => {});
  }

  /** Item context the providers need (show name for episodes). */
  context(item) {
    const show = item.showId && this.library.shows.get(item.showId);
    return { ...item, showName: show?.name };
  }

  /** True when the item already has a local subtitle in one of the preferred languages. */
  hasPreferredLocal(item) {
    const subs = this.library.publicItem(item).subtitles;
    return subs.some((s) => this.languages.includes(toIso1(s.lang)));
  }

  async search(item) {
    const ctx = this.context(item);
    let hash = null;
    if (!item.virtualSource) {
      try {
        hash = await openSubtitlesHash(item.path);
      } catch {}
    }
    const results = await Promise.allSettled(this.providers.map((p) => p.search(ctx, { languages: this.languages, hash })));
    const all = [];
    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') all.push(...r.value);
      else {
        const st = r.reason?.status;
        const why = st === 401 || st === 403 ? 'API key rejected (run `shoebox config` to fix it)' : st === 429 ? 'rate limited, try again later' : r.reason?.message;
        errors.push(`${this.providers[i].label}: ${why}`);
      }
    });
    for (const e of errors) this.log(`subtitle search: ${e}`);
    return { candidates: rank(all, item, this.languages), errors };
  }

  /** Download a candidate and save it next to the video (or in the cache when that folder is read-only). */
  async download(item, candidate) {
    const provider = this.providers.find((p) => p.name === candidate.provider);
    if (!provider) throw new Error(`provider ${candidate.provider} is not configured`);
    const { text, ext } = await provider.download(candidate, this.context(item));
    if (!/\d\d:\d\d/.test(text)) throw new Error('downloaded file does not look like a subtitle');
    const lang = toIso1(candidate.lang) || 'und';
    const dir = path.dirname(item.path);
    const base = path.basename(item.path, path.extname(item.path));
    let target = path.join(dir, `${base}.${lang}${ext}`);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}.${lang}.${n}${ext}`);
    try {
      await fsp.writeFile(target, text, 'utf8');
    } catch {
      target = path.join(this.library.cacheDir, 'subs', `${item.id}.${lang}${ext}`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, text, 'utf8');
    }
    this.log(`Downloaded ${languageName(lang)} subtitles for ${item.rel} from ${provider.label}`);
    this.library.refreshSubtitles(item);
    this.index[item.id] = { at: Date.now(), result: 'ok', provider: provider.name };
    this.saveIndex();
    const file = path.resolve(target);
    return { key: item.externalSubs.find((s) => s.file === file)?.key, lang };
  }

  /** Fetch the best subtitle automatically, once per item (misses are remembered for 3 days). */
  async auto(item) {
    if (!this.enabled || !this.autoDownload) return { fetched: false, reason: 'disabled' };
    if (this.hasPreferredLocal(item)) return { fetched: false, reason: 'local subtitles available' };
    const prev = this.index[item.id];
    if (prev?.result === 'miss' && Date.now() - prev.at < 3 * 86400_000) return { fetched: false, reason: 'no match found recently' };
    if (this.inflight.has(item.id)) return this.inflight.get(item.id);
    const job = (async () => {
      const { candidates } = await this.search(item);
      for (const c of candidates.slice(0, 4)) {
        try {
          const r = await this.download(item, c);
          return { fetched: true, ...r, provider: c.providerLabel, release: c.release };
        } catch (e) {
          this.log(`subtitle download from ${c.providerLabel} failed: ${e.message}`);
        }
      }
      this.index[item.id] = { at: Date.now(), result: 'miss' };
      this.saveIndex();
      return { fetched: false, reason: candidates.length ? 'downloads failed' : 'no match found' };
    })().finally(() => this.inflight.delete(item.id));
    this.inflight.set(item.id, job);
    return job;
  }
}

