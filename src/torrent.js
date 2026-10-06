import fs from 'node:fs';
import path from 'node:path';
import { parsePath } from './parse.js';
import { VIDEO_EXT, hash } from './library.js';

/**
 * Optional torrent support via webtorrent (lazy-loaded optional dependency).
 * Files download into <root>/Torrents. While downloading, video files are exposed to the library as
 * "virtual" items that stream straight from the torrent; once done they become ordinary files.
 *
 * Torrents last for one session: nothing resumes on the next start. Adding the same torrent again
 * continues from the data already on disk. Until then, unfinished files are kept out of the library
 * (tracked in <cacheDir>/torrents.json) so half-downloaded videos don't show up as broken items.
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
    this.unfinished = this.loadUnfinished();
    for (const entry of Object.values(this.unfinished)) {
      for (const rel of entry.files) this.library.excluded.add(path.join(this.library.root, rel));
    }
  }

  /** { infoHash: { name, files: [rel paths] } } for downloads left unfinished; vanished files are dropped. */
  loadUnfinished() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
    // Older versions stored a list of torrents to resume; that format carries no file list, so it's ignored.
    const entries = data && !Array.isArray(data) && typeof data.unfinished === 'object' ? data.unfinished : {};
    const out = {};
    for (const [ih, e] of Object.entries(entries)) {
      const files = (Array.isArray(e?.files) ? e.files : []).filter((rel) => fs.existsSync(path.join(this.library.root, rel)));
      if (files.length) out[ih] = { name: String(e.name || ih), files };
    }
    return out;
  }

  saveUnfinished() {
    fs.writeFile(this.stateFile, JSON.stringify({ unfinished: this.unfinished }), () => {});
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
    const left = Object.values(this.unfinished);
    if (left.length) {
      this.log(`${left.length} unfinished torrent download${left.length > 1 ? 's' : ''} hidden from the library until added again: ${left.map((e) => e.name).join(', ')}`);
    }
  }

  /**
   * @param {string|Buffer} source magnet URI, info hash, or .torrent contents
   * @returns {Promise<object>} the torrent's description; `duplicate: true` when it was already added
   */
  async add(source) {
    if (!this.client) throw new Error(this.error || 'torrent support not initialised');
    // Same torrent in any form (hex/base32 magnet, bare hash, .torrent file) → report it instead of failing.
    let existing = null;
    try {
      existing = await this.client.get(source);
    } catch {}
    if (existing) return { ...this.describe(existing), duplicate: true };
    fs.mkdirSync(this.dir, { recursive: true });
    return new Promise((resolve, reject) => {
      let settled = false;
      let torrent;
      try {
        torrent = this.client.add(source, { path: this.dir }, (t) => {
          // webtorrent hands back the existing torrent when this one turns out to be a duplicate.
          const duplicate = t !== torrent;
          if (!duplicate) this.onReady(t); // always, even if we already answered after the 4s timeout
          if (settled) return;
          settled = true;
          resolve(duplicate ? { ...this.describe(t), duplicate: true } : this.describe(t));
        });
      } catch (e) {
        return reject(e);
      }
      torrent.on('error', (e) => {
        if (/duplicate torrent/i.test(e.message)) return; // resolved as a duplicate above
        this.log(`torrent error: ${e.message}`);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      // Magnet links can take a while to fetch metadata; report back immediately instead of blocking.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(this.describe(torrent));
        }
      }, 4000);
    });
  }

  onReady(t) {
    const resumed = !!this.unfinished[t.infoHash];
    this.log(`Torrent ready: ${t.name} (${t.files.length} files)${resumed && !t.done ? ', continuing from the data already downloaded' : ''}`);
    const videos = this.videoFiles(t);
    const finish = () => {
      delete this.unfinished[t.infoHash];
      this.saveUnfinished();
      for (const { file } of this.videoFiles(t)) {
        const abs = path.join(this.dir, file.path);
        this.library.excluded.delete(abs);
        this.library.removeVirtual(hash(this.rel(abs)));
      }
      this.library.scan();
    };
    // Already complete (e.g. re-added after it finished): 'done' won't fire, so show the files now.
    if (t.done) return finish();
    if (videos.length) {
      this.unfinished[t.infoHash] = { name: t.name, files: videos.map(({ file }) => this.rel(path.join(this.dir, file.path))) };
      this.saveUnfinished();
    }
    for (const { file, idx } of videos) {
      this.library.excluded.add(path.join(this.dir, file.path));
      this.library.addVirtual(this.virtualItem(t, file, idx));
    }
    this.probeVirtual(t);
    t.once('done', () => {
      this.log(`Torrent finished: ${t.name}`);
      finish();
    });
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
        // Kept but unfinished files stay hidden from the library until the torrent is added again.
        const keepHidden = !deleteFiles && !t.done && !!this.unfinished[infoHash];
        for (const { file } of files) {
          const abs = path.join(this.dir, file.path);
          if (!keepHidden) this.library.excluded.delete(abs);
          this.library.removeVirtual(hash(this.rel(abs)));
        }
        if (!keepHidden && this.unfinished[infoHash]) {
          delete this.unfinished[infoHash];
          this.saveUnfinished();
        }
        this.library.scan();
        resolve(true);
      });
    });
  }

  shutdown() {
    return new Promise((r) => (this.client ? this.client.destroy(() => r()) : r()));
  }
}
