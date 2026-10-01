import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parsePath, normKey, similarity, naturalCompare } from './parse.js';
import { probe, grabFrame, keyframes } from './ffmpeg.js';
import { Artwork } from './artwork.js';
import { parseSubtitleTags, languageName, toIso1 } from './lang.js';

export const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.3gp', '.ogv', '.divx', '.vob',
]);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const SKIP_DIRS = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information', '@eaDir']);

export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Small promise queue with fixed concurrency. */
class Queue {
  constructor(concurrency) {
    this.c = concurrency;
    this.running = 0;
    this.q = [];
    this.keys = new Set();
  }
  push(key, fn) {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.q.push({ key, fn });
    this.next();
  }
  next() {
    while (this.running < this.c && this.q.length) {
      const { key, fn } = this.q.shift();
      this.running++;
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this.keys.delete(key);
          this.next();
        });
    }
  }
  get pending() {
    return this.q.length + this.running;
  }
}

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class Library extends EventEmitter {
  constructor(root, { artwork, log = () => {} } = {}) {
    super();
    this.root = path.resolve(root);
    this.log = log;
    this.artwork = artwork;
    this.items = new Map(); // id → item
    this.shows = new Map(); // id → show
    this.virtual = new Map(); // id → item supplied by other providers (torrents)
    this.excluded = new Set(); // absolute paths not to scan (incomplete torrent files)
    this.scanning = false;
    this.lastScan = 0;

    const local = path.join(this.root, '.shoebox');
    this.cacheDir = writableDir(local) ? local : path.join(os.homedir(), '.cache', 'shoebox', hash(this.root));
    for (const d of ['thumbs', 'kf', 'art']) fs.mkdirSync(path.join(this.cacheDir, d), { recursive: true });
    this.cacheFile = path.join(this.cacheDir, 'probe-cache.json');
    try {
      this.probeCache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
    } catch {
      this.probeCache = {};
    }

    this.probeQ = new Queue(Math.min(4, os.cpus().length));
    this.thumbQ = new Queue(2);
    this.kfQ = new Queue(1);
    this.saveTimer = null;
  }

  thumbPath(id) {
    return path.join(this.cacheDir, 'thumbs', `${id}.jpg`);
  }
  kfPath(id) {
    return path.join(this.cacheDir, 'kf', `${id}.json`);
  }

  saveCacheSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fsp.writeFile(this.cacheFile, JSON.stringify(this.probeCache)).catch(() => {});
    }, 1000);
  }

  async walk(dir, depth, out) {
    if (depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = await fsp.stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) await this.walk(abs, depth + 1, out);
      else if (isFile && VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !this.excluded.has(abs)) out.push(abs);
    }
  }

  async scan() {
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    const t0 = Date.now();
    try {
      const files = [];
      await this.walk(this.root, 0, files);
      const videosPerDir = new Map();
      for (const f of files) videosPerDir.set(path.dirname(f), (videosPerDir.get(path.dirname(f)) || 0) + 1);
      const readDir = dirReader();
      const items = new Map();
      for (const abs of files) {
        let st;
        try {
          st = await fsp.stat(abs);
        } catch {
          continue;
        }
        if (st.size < 1024 * 100) continue; // skip tiny samples/broken files
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        const id = hash(rel);
        const prev = this.items.get(id);
        const cached = this.probeCache[rel];
        const fresh = cached && cached.size === st.size && cached.mtime === st.mtimeMs;
        const onlyVideo = videosPerDir.get(path.dirname(abs)) === 1;
        items.set(id, {
          id,
          rel,
          path: abs,
          input: abs,
          ext: path.extname(abs).toLowerCase(),
          size: st.size,
          mtime: st.mtimeMs,
          added: st.birthtimeMs || st.ctimeMs,
          parsed: parsePath(rel),
          probe: fresh ? cached.probe : prev?.probe && prev.size === st.size ? prev.probe : null,
          onlyVideo,
          externalSubs: this.findSidecars(abs, id, onlyVideo, readDir),
          thumb: fs.existsSync(this.thumbPath(id)),
          keyframesReady: fs.existsSync(this.kfPath(id)),
        });
      }
      this.items = items;
      this.group();
      this.lastScan = Date.now();
      this.log(`Scanned ${items.size} videos (${this.shows.size} shows) in ${Date.now() - t0}ms`);
      this.emit('change');
      this.enqueueBackground();
    } finally {
      this.scanning = false;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        setTimeout(() => this.scan(), 500);
      }
    }
  }

  /** Turn parsed items into shows + movies. */
  group() {
    const all = [...this.items.values(), ...this.virtual.values()];
    // 1. "maybe" episodes (trailing numbers) count only when siblings share the prefix.
    const strongKeys = new Set(all.filter((i) => i.parsed.kind === 'episode').map((i) => normKey(i.parsed.show)));
    const maybeGroups = new Map();
    for (const it of all) {
      if (it.parsed.kind !== 'maybe') continue;
      const k = path.dirname(it.rel) + '|' + normKey(it.parsed.show);
      if (!maybeGroups.has(k)) maybeGroups.set(k, []);
      maybeGroups.get(k).push(it);
    }
    for (const [k, list] of maybeGroups) {
      const isShow = list.length >= 2 || strongKeys.has(k.split('|')[1]);
      for (const it of list) it.kind = isShow ? 'episode' : 'movie';
    }
    for (const it of all) if (it.parsed.kind !== 'maybe') it.kind = it.parsed.kind;

    // 2. Bucket episodes by normalized show name.
    const buckets = new Map();
    for (const it of all) {
      if (it.kind !== 'episode') continue;
      let name = it.parsed.show;
      if (!name || name === 'Unknown Show') name = it.parsed.folderShow || 'Unknown Show';
      const key = normKey(name) || 'unknown';
      if (!buckets.has(key)) buckets.set(key, { key, names: [], folders: [], items: [] });
      const b = buckets.get(key);
      b.names.push(name);
      if (it.parsed.folderShow) b.folders.push(it.parsed.folderShow);
      b.items.push(it);
    }

    // 3. Fuzzy-merge buckets with near-identical names ("The Office" / "Office", typos, glued names).
    const list = [...buckets.values()].sort((a, b) => b.items.length - a.items.length);
    const merged = [];
    for (const b of list) {
      const target = merged.find((m) => {
        const s = similarity(m.key, b.key);
        if (s >= 0.85) return true;
        const [short, long] = m.key.length < b.key.length ? [m.key, b.key] : [b.key, m.key];
        if (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2) return true;
        // Same parent show folder and reasonably similar names.
        const fa = mostCommon(m.folders);
        const fb = mostCommon(b.folders);
        return fa && fb && normKey(fa) === normKey(fb) && s >= 0.5;
      });
      if (target) {
        target.names.push(...b.names);
        target.folders.push(...b.folders);
        target.items.push(...b.items);
      } else merged.push({ ...b, names: [...b.names], folders: [...b.folders], items: [...b.items] });
    }

    // 4. Build show objects; a lone weakly-detected "episode" becomes a movie.
    const shows = new Map();
    for (const b of merged) {
      const strong = b.items.some((i) => i.parsed.strength >= 3);
      if (b.items.length === 1 && !strong) {
        b.items[0].kind = 'movie';
        continue;
      }
      const folder = mostCommon(b.folders);
      const fname = mostCommon(b.names);
      const name =
        folder && (similarity(normKey(folder), b.key) >= 0.7 || normKey(folder).startsWith(b.key) || b.key.startsWith(normKey(folder)))
          ? folder
          : fname;
      const id = 's' + hash(b.key);
      b.items.sort(
        (x, y) =>
          (x.parsed.season ?? 1) - (y.parsed.season ?? 1) ||
          (x.parsed.episode ?? 0) - (y.parsed.episode ?? 0) ||
          naturalCompare(x.rel, y.rel)
      );
      // Specials (season 0) go last.
      const ordered = [...b.items.filter((i) => i.parsed.season !== 0), ...b.items.filter((i) => i.parsed.season === 0)];
      ordered.forEach((it, i) => {
        it.showId = id;
        it.order = i;
      });
      const seasons = [...new Set(ordered.map((i) => i.parsed.season ?? 1))];
      shows.set(id, {
        id,
        name,
        key: b.key,
        seasons,
        episodes: ordered.map((i) => i.id),
        added: Math.max(...ordered.map((i) => i.added || 0)),
      });
    }
    for (const it of all) {
      if (it.kind === 'movie') {
        it.showId = null;
        it.title = it.parsed.movieTitle || it.parsed.title || path.basename(it.rel, it.ext);
      }
    }
    this.shows = shows;
  }

  enqueueBackground() {
    for (const it of this.items.values()) {
      if (!it.probe) {
        this.probeQ.push('p' + it.id, async () => {
          try {
            it.probe = await probe(it.input);
            this.probeCache[it.rel] = { size: it.size, mtime: it.mtime, probe: it.probe };
            this.saveCacheSoon();
            this.emit('change');
            this.enqueueItemWork(it);
          } catch (e) {
            it.probeError = e.message;
            this.log(`probe failed: ${it.rel}: ${e.message}`);
          }
        });
      } else this.enqueueItemWork(it);
    }
    if (this.artwork) {
      for (const show of this.shows.values()) this.artwork.enqueueShow(show, () => this.emit('change'));
      for (const it of this.items.values()) if (it.kind === 'movie') this.artwork.enqueueMovie(it, () => this.emit('change'));
    }
  }

  enqueueItemWork(it) {
    if (!it.thumb && it.probe?.video) {
      this.thumbQ.push('t' + it.id, async () => {
        const d = it.probe.duration || 0;
        const at = d > 60 ? Math.min(d * 0.15, 300) : d * 0.3;
        await grabFrame(it.input, at, this.thumbPath(it.id));
        it.thumb = true;
        this.emit('change');
      });
    }
    // Pre-compute keyframe index for files that probably need remuxing (non-MP4 H.264).
    if (
      !it.keyframesReady &&
      !it.virtualSource &&
      it.probe?.video?.codec === 'h264' &&
      !['.mp4', '.m4v', '.mov'].includes(it.ext)
    ) {
      this.kfQ.push('k' + it.id, () => this.ensureKeyframes(it));
    }
  }

  async ensureKeyframes(it) {
    if (it.keyframesReady) return JSON.parse(await fsp.readFile(this.kfPath(it.id), 'utf8'));
    const kf = await keyframes(it.input);
    await fsp.writeFile(this.kfPath(it.id), JSON.stringify(kf));
    it.keyframesReady = true;
    return kf;
  }

  async getKeyframes(it) {
    if (!it.keyframesReady) return null;
    try {
      return JSON.parse(await fsp.readFile(this.kfPath(it.id), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Subtitle files that belong to a video:
   *  - next to it, named after it ("Movie.en.srt", "Movie.English.forced.srt")
   *  - in a Subs/ or Subtitles/ folder beside it, by name or in a folder named after the video
   *    ("Subs/Show.S01E01/2_English.srt", common in release packs)
   *  - any subtitle in the folder (or its Subs/ folder) when the folder holds only this video
   *  - ones previously downloaded into the cache because the video's folder was read-only
   */
  findSidecars(abs, id, onlyVideo, readDir = dirReader()) {
    const dir = path.dirname(abs);
    const base = path.basename(abs, path.extname(abs)).toLowerCase();
    const found = new Map();
    const add = (file, remainder) => {
      if (found.has(file)) return;
      const tags = parseSubtitleTags(remainder);
      const name = languageName(tags.lang);
      const label = [name || path.basename(file), tags.forced && '(forced)', tags.hi && 'SDH'].filter(Boolean).join(' ');
      found.set(file, { key: 'e' + hash(file).slice(0, 10), file, lang: tags.lang, forced: tags.forced, hi: tags.hi, label });
    };
    const scanDir = (d, any) => {
      for (const e of readDir(d)) {
        if (e.isDir || !SUB_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const stem = e.name.slice(0, -path.extname(e.name).length);
        if (stem.toLowerCase().startsWith(base)) add(path.join(d, e.name), stem.slice(base.length));
        else if (any) add(path.join(d, e.name), stem);
      }
    };
    scanDir(dir, onlyVideo);
    for (const e of readDir(dir)) {
      if (!e.isDir || !/^(subs?|subtitles?)$/i.test(e.name)) continue;
      const subDir = path.join(dir, e.name);
      scanDir(subDir, onlyVideo);
      for (const inner of readDir(subDir)) {
        if (inner.isDir && inner.name.toLowerCase() === base) scanDir(path.join(subDir, inner.name), true);
      }
    }
    const cacheSubs = path.join(this.cacheDir, 'subs');
    for (const e of readDir(cacheSubs)) {
      if (e.name.startsWith(id + '.')) add(path.join(cacheSubs, e.name), e.name.slice(id.length, -path.extname(e.name).length));
    }
    return [...found.values()];
  }

  /** Re-read an item's subtitle files (after a download) without a full rescan. */
  refreshSubtitles(item) {
    item.externalSubs = this.findSidecars(item.path, item.id, !!item.onlyVideo);
    this.emit('change');
  }

  get(id) {
    return this.items.get(id) || this.virtual.get(id);
  }

  addVirtual(item) {
    this.virtual.set(item.id, item);
    this.group();
    this.emit('change');
  }
  removeVirtual(id) {
    if (this.virtual.delete(id)) {
      this.group();
      this.emit('change');
    }
  }

  watch() {
    let timer;
    const trigger = (_ev, file) => {
      if (file && (String(file).includes('.shoebox') || /(^|[\\/])\./.test(String(file)))) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.scan(), 3000);
    };
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, trigger);
    } catch {
      // Recursive watch unsupported: fall back to periodic rescans.
      this.watchInterval = setInterval(() => this.scan(), 60000);
    }
  }

  /** Public JSON for the UI. */
  publicItem(it) {
    const p = it.probe;
    return {
      id: it.id,
      kind: it.kind,
      rel: it.rel,
      title: it.kind === 'movie' ? it.title : it.parsed.title,
      showId: it.showId || null,
      season: it.parsed.season,
      episode: it.parsed.episode,
      episodeEnd: it.parsed.episodeEnd,
      year: it.parsed.year,
      duration: p?.duration || it.duration || 0,
      size: it.size,
      added: it.added,
      thumb: !!it.thumb,
      poster: it.kind === 'movie' ? this.artwork?.url(Artwork.movieKey(it)) ?? null : null,
      overview: it.kind === 'movie' ? this.artwork?.get(Artwork.movieKey(it))?.overview : undefined,
      width: p?.video?.width,
      height: p?.video?.height,
      vcodec: p?.video?.codec,
      acodec: p?.audio?.[0]?.codec,
      audio: (p?.audio || []).map((a) => ({ n: a.n, codec: a.codec, lang: langName(a.lang), title: a.title, channels: a.channels, default: a.default })),
      subtitles: [
        // Files beside the video come first: someone put them there on purpose.
        ...(it.externalSubs || []).map((s) => ({ key: s.key, lang: s.lang, label: s.label, forced: s.forced, hi: s.hi, external: true })),
        ...(p?.subtitles || []).filter((s) => s.text).map((s) => ({
          key: `i${s.index}`,
          lang: toIso1(s.lang) || s.lang,
          label: [s.title, langName(s.lang)].filter(Boolean).join(' · ') || `Track ${s.n + 1}`,
          default: s.default,
          forced: s.forced,
        })),
      ],
      torrent: it.virtualSource ? { infoHash: it.infoHash, progress: it.progressFn?.() ?? 0 } : undefined,
    };
  }

  snapshot() {
    const all = [...this.items.values(), ...this.virtual.values()];
    return {
      root: this.root,
      name: path.basename(this.root),
      scanning: this.scanning,
      pending: { probe: this.probeQ.pending, thumbs: this.thumbQ.pending, art: this.artwork?.pending || 0 },
      shows: [...this.shows.values()].map((s) => ({
        id: s.id,
        name: s.name,
        seasons: s.seasons,
        episodes: s.episodes,
        poster: this.artwork?.url(Artwork.showKey(s)) ?? null,
        overview: this.artwork?.get(Artwork.showKey(s))?.overview,
        added: s.added,
      })),
      items: all.map((it) => this.publicItem(it)),
    };
  }
}

const langNames = new Intl.DisplayNames(['en'], { type: 'language' });
function langName(code) {
  if (!code || code === 'und') return undefined;
  try {
    const n = langNames.of(code);
    return n && n !== code ? n : code;
  } catch {
    return code;
  }
}

/** Cached directory listing for one scan; missing directories read as empty. */
function dirReader() {
  const cache = new Map();
  return (d) => {
    if (!cache.has(d)) {
      try {
        cache.set(d, fs.readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() })));
      } catch {
        cache.set(d, []);
      }
    }
    return cache.get(d);
  };
}

function mostCommon(arr) {
  if (!arr.length) return undefined;
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
