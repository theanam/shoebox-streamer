import fs from 'node:fs';
import path from 'node:path';
import { parsePath } from './parse.js';
import { VIDEO_EXT, hash } from './library.js';

/**
 * Optional torrent support via webtorrent (lazy-loaded optional dependency).
 * Files download into <root>/Torrents. While downloading, video files are exposed to the library as
 * "virtual" items that stream straight from the torrent; once done they become ordinary files.
 */
export class Torrents {
  constructor({ library, getPort, log = () => {} }) {
    this.library = library;
    this.getPort = getPort;
    this.log = log;
    this.dir = path.join(library.root, 'Torrents');
    this.stateFile = path.join(library.cacheDir, 'torrents.json');
    this.client = null;
    this.available = null;
    this.error = null;
  }

  async init() {
    try {
      const { default: WebTorrent } = await import('webtorrent');
      this.client = new WebTorrent();
      this.client.on('error', (e) => this.log(`torrent client error: ${e.message}`));
      this.available = true;
    } catch (e) {
      this.available = false;
      this.error = 'Torrent support unavailable (optional dependency "webtorrent" failed to load): ' + e.message;
      return;
    }
    // Resume torrents from a previous run.
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const t of saved) {
        const src = t.magnet || (t.torrentFile && Buffer.from(t.torrentFile, 'base64'));
        if (src) this.add(src).catch((e) => this.log(`could not resume torrent: ${e.message}`));
      }
    } catch {}
  }

  persist() {
    if (!this.client) return;
    // magnetURI is only known once a torrent is parsed, so fall back to the source it was added from.
    const list = this.client.torrents
      .map((t) => {
        const src = t.shoeboxSource;
        if (t.magnetURI) return { magnet: t.magnetURI };
        if (typeof src === 'string') return { magnet: src };
        if (src) return { torrentFile: Buffer.from(src).toString('base64') };
        return null;
      })
      .filter(Boolean);
    fs.writeFile(this.stateFile, JSON.stringify(list), () => {});
  }

  /** @param {string|Buffer} source magnet URI, info hash, or .torrent contents */
  add(source) {
    if (!this.client) return Promise.reject(new Error(this.error || 'torrent support not initialised'));
    fs.mkdirSync(this.dir, { recursive: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      const existing = typeof source === 'string' && this.client.torrents.find((t) => source.includes(t.infoHash));
      if (existing) return resolve(this.describe(existing));
      let torrent;
      try {
        torrent = this.client.add(source, { path: this.dir }, (t) => {
          this.onReady(t);
          settled = true;
          resolve(this.describe(t));
        });
      } catch (e) {
        return reject(e);
      }
      torrent.shoeboxSource = source;
      torrent.on('error', (e) => {
        this.log(`torrent error: ${e.message}`);
        if (!settled) reject(e);
      });
      // Magnet links can take a while to fetch metadata; report back immediately instead of blocking.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(this.describe(torrent));
        }
      }, 4000);
      this.persist();
    });
  }

  onReady(t) {
    this.log(`Torrent ready: ${t.name} (${t.files.length} files)`);
    this.persist();
    const videos = this.videoFiles(t);
    for (const { file } of videos) {
      const abs = path.join(this.dir, file.path);
      this.library.excluded.add(abs);
    }
    if (!t.done) {
      for (const { file, idx } of videos) this.library.addVirtual(this.virtualItem(t, file, idx));
      this.probeVirtual(t);
    }
    t.on('done', () => {
      this.log(`Torrent finished: ${t.name}`);
      for (const { file } of this.videoFiles(t)) {
        const abs = path.join(this.dir, file.path);
        this.library.excluded.delete(abs);
        this.library.removeVirtual(hash(this.rel(abs)));
      }
      this.library.scan();
    });
    if (t.done) this.library.scan();
  }

  rel(abs) {
    return path.relative(this.library.root, abs).split(path.sep).join('/');
  }

  videoFiles(t) {
    return t.files
      .map((file, idx) => ({ file, idx }))
      .filter(({ file }) => VIDEO_EXT.has(path.extname(file.name).toLowerCase()) && !/sample/i.test(file.name));
  }

  virtualItem(t, file, idx) {
    const abs = path.join(this.dir, file.path);
    const rel = this.rel(abs);
    return {
      id: hash(rel), // same id the finished file will get, so watch progress carries over
      rel,
      path: abs,
      input: `http://127.0.0.1:${this.getPort()}/api/torrents/${t.infoHash}/${idx}/raw`,
      ext: path.extname(file.name).toLowerCase(),
      size: file.length,
      mtime: 0,
      added: Date.now(),
      parsed: parsePath(rel),
      probe: null,
      externalSubs: this.library.findSidecars(abs, hash(rel), false),
      thumb: false,
      keyframesReady: false,
      virtualSource: true,
      infoHash: t.infoHash,
      progressFn: () => file.progress,
      createReadStream: (opts) => file.createReadStream(opts),
    };
  }

  async probeVirtual(t) {
    const { probe } = await import('./ffmpeg.js');
    for (const { file } of this.videoFiles(t)) {
      const it = this.library.get(hash(this.rel(path.join(this.dir, file.path))));
      if (!it || it.probe) continue;
      for (let attempt = 0; attempt < 3 && !it.probe; attempt++) {
        try {
          it.probe = await probe(it.input);
          this.library.emit('change');
        } catch (e) {
          this.log(`probe (torrent) failed for ${it.rel}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  get(infoHash) {
    return this.client?.torrents.find((t) => t.infoHash === infoHash);
  }

  describe(t) {
    const ready = !!t.files?.length;
    return {
      infoHash: t.infoHash,
      name: t.name || t.infoHash || 'Fetching metadata…',
      ready,
      done: !!t.done,
      progress: t.progress || 0,
      downloadSpeed: t.downloadSpeed || 0,
      uploadSpeed: t.uploadSpeed || 0,
      peers: t.numPeers || 0,
      size: t.length || 0,
      downloaded: t.downloaded || 0,
      timeRemaining: Number.isFinite(t.timeRemaining) ? t.timeRemaining : null,
      paused: !!t.paused,
      files: ready
        ? this.videoFiles(t).map(({ file, idx }) => ({
            idx,
            name: file.name,
            size: file.length,
            progress: file.progress,
            id: hash(this.rel(path.join(this.dir, file.path))),
          }))
        : [],
    };
  }

  list() {
    return (this.client?.torrents || []).map((t) => this.describe(t));
  }

  remove(infoHash, deleteFiles = false) {
    const t = this.get(infoHash);
    if (!t) return false;
    const files = t.files ? this.videoFiles(t) : [];
    return new Promise((resolve) => {
      this.client.remove(t, { destroyStore: deleteFiles }, () => {
        for (const { file } of files) {
          const abs = path.join(this.dir, file.path);
          this.library.excluded.delete(abs);
          this.library.removeVirtual(hash(this.rel(abs)));
        }
        this.persist();
        this.library.scan();
        resolve(true);
      });
    });
  }

  shutdown() {
    return new Promise((r) => (this.client ? this.client.destroy(() => r()) : r()));
  }
}
