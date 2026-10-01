import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decide } from './decide.js';
import { HlsManager, profileString } from './hls.js';
import { toWebVTT, pickEncoder } from './ffmpeg.js';
import { decodeText } from './subtitles.js';

const require = createRequire(import.meta.url);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HLS_JS = (() => {
  try {
    return path.join(path.dirname(require.resolve('hls.js/package.json')), 'dist', 'hls.min.js');
  } catch {
    return null;
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), 'application/json');

async function readBody(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? size - parseInt(m[2], 10) : parseInt(m[1], 10);
  let end = m[1] === '' || m[2] === '' ? size - 1 : parseInt(m[2], 10);
  if (isNaN(start) || isNaN(end) || start > end || start >= size) return 'invalid';
  return { start: Math.max(0, start), end: Math.min(end, size - 1) };
}

/** Stream a byte source (file path or createReadStream fn) honoring Range requests. */
function streamRange(req, res, { size, type, open, filename }) {
  const range = parseRange(req.headers.range, size);
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  if (filename) headers['content-disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  headers['content-length'] = end - start + 1;
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = open({ start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy?.());
  stream.pipe(res);
}

function serveFile(req, res, file, type) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    streamRange(req, res, { size: st.size, type: type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', open: (r) => fs.createReadStream(file, r) });
  });
}

function serveCached(res, file, type, maxAge = 3600) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': type, 'cache-control': `public, max-age=${maxAge}`, 'content-length': buf.length });
    res.end(buf);
  });
}

/** SRT → WebVTT in JS (handles any text encoding); other formats go through ffmpeg on a UTF-8 copy. */
export function srtToVtt(text) {
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/\{\\[^}]*\}/g, '') // {\an8} style overrides
    .replace(/(\d+):(\d\d):(\d\d)[,.](\d{1,3})/g, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`);
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

async function externalToVtt(file, cacheDir) {
  const text = decodeText(await fsp.readFile(file));
  const ext = path.extname(file).toLowerCase();
  if (ext === '.vtt') return text.startsWith('WEBVTT') ? text : 'WEBVTT\n\n' + text;
  if (ext === '.srt') return srtToVtt(text);
  const tmp = path.join(cacheDir, `conv-${process.pid}-${Date.now()}${ext}`);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    return await toWebVTT(tmp);
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

const isLoopback = (req) => {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

function episodeLabel(lib, it) {
  if (it.kind !== 'episode') return it.title;
  const show = lib.shows.get(it.showId);
  const se = `S${String(it.parsed.season ?? 1).padStart(2, '0')}E${String(it.parsed.episode ?? 0).padStart(2, '0')}`;
  return [show?.name, se, it.parsed.title].filter(Boolean).join(' - ');
}

export function createApp({ library, artwork, torrents, subtitles, info, log }) {
  const hls = new HlsManager({ library, log });
  const sseClients = new Set();

  let pushTimer = null;
  const pushChange = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      for (const res of sseClients) res.write(`event: library\ndata: ${Date.now()}\n\n`);
    }, 800);
  };
  library.on('change', pushChange);

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------------------------------------------------------------- API
  route('GET', /^\/api\/info$/, async (req, res) => {
    json(res, {
      ...info(),
      encoder: await pickEncoder(),
      torrents: { available: torrents?.available ?? false, error: torrents?.error },
      subtitles: subtitles?.publicInfo() || { providers: [], languages: [], autoDownload: false },
      activeTranscodes: hls.activeJobs,
    });
  });

  route('GET', /^\/api\/library$/, (req, res) => json(res, library.snapshot()));

  route('POST', /^\/api\/rescan$/, (req, res) => {
    library.scan();
    json(res, { ok: true });
  });

  route('GET', /^\/api\/events$/, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  route('POST', /^\/api\/play\/([\w]+)$/, async (req, res, [, id]) => {
    const it = library.get(id);
    if (!it) return json(res, { error: 'not found' }, 404);
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const caps = body.caps || {};
    const client = String(body.client || 'anon').replace(/[^\w-]/g, '').slice(0, 40) || 'anon';
    if (!it.probe) {
      // Probe on demand so the very first play doesn't wait for the background queue.
      try {
        const { probe } = await import('./ffmpeg.js');
        it.probe = await probe(it.input);
      } catch (e) {
        return json(res, { error: `Could not read this file: ${e.message}` }, 500);
      }
    }
    const canRemux = !it.virtualSource && (it.keyframesReady || false);
    if (!canRemux && !it.virtualSource && it.probe.video?.codec === 'h264' && !it.keyframesReady) {
      // Kick off indexing so next time this file can be remuxed instead of transcoded.
      library.kfQ.push('k' + it.id, () => library.ensureKeyframes(it));
    }
    let d = decide(it, caps, { quality: body.quality, audio: body.audio, canRemux });
    if (body.force && d.mode === 'direct') {
      // The browser claimed support but failed to play the file: convert it on the server instead.
      d = decide(it, { ...caps, mp4: false, webm: false }, { quality: body.quality, audio: body.audio, canRemux });
      d.reason = `${d.mode === 'remux' ? 'Remuxing' : 'Transcoding'}: direct play failed on this device`;
    }
    hls.stopClient(client);
    const out = { mode: d.mode, reason: d.reason, audio: d.audio, duration: it.probe.duration };
    if (d.mode === 'direct') out.url = `/media/${it.id}`;
    else out.url = `/hls/${it.id}/${profileString(d)}/${client}/index.m3u8`;
    if (d.height) out.height = d.height;
    json(res, out);
  });

  route('POST', /^\/api\/stop$/, async (req, res) => {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (body.client) hls.stopClient(String(body.client).replace(/[^\w-]/g, ''));
    json(res, { ok: true });
  });

  // ---------------------------------------------------------------- media
  route(['GET', 'HEAD'], /^\/media\/([\w]+)(?:\/[^/]*)?$/, (req, res, [, id]) => {
    const it = library.get(id);
    if (!it) return send(res, 404, 'not found');
    const type = MIME[it.ext] || 'application/octet-stream';
    const filename = path.basename(it.rel);
    if (it.createReadStream) {
      return streamRange(req, res, { size: it.size, type, filename, open: (r) => it.createReadStream({ start: r.start, end: r.end }) });
    }
    streamRange(req, res, { size: it.size, type, filename, open: (r) => fs.createReadStream(it.path, r) });
  });

  route('GET', /^\/hls\/([\w]+)\/([\w-]+)\/([\w-]+)\/index\.m3u8$/, async (req, res, [, id, profile, client]) => {
    const it = library.get(id);
    if (!it) return send(res, 404, 'not found');
    try {
      const s = await hls.session(it, profile, client);
      send(res, 200, s.playlist(), 'application/vnd.apple.mpegurl');
    } catch (e) {
      send(res, e.status || 500, e.message);
    }
  });

  route('GET', /^\/hls\/([\w]+)\/([\w-]+)\/([\w-]+)\/seg-(\d+)\.ts$/, async (req, res, [, id, profile, client, n]) => {
    const it = library.get(id);
    if (!it) return send(res, 404, 'not found');
    try {
      const s = await hls.session(it, profile, client);
      const file = await s.getSegment(parseInt(n, 10));
      if (!file) return send(res, 404, 'no such segment');
      const buf = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': buf.length, 'cache-control': 'no-cache' });
      res.end(buf);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, e.message);
    }
  });

  route('GET', /^\/api\/subs\/([\w]+)\/([ie][0-9a-f]+)\.vtt$/, async (req, res, [, id, key]) => {
    const it = library.get(id);
    if (!it) return send(res, 404, 'not found');
    try {
      if (key[0] === 'e') {
        // External files are converted on every request, so edits and replacements show up immediately.
        const ext = it.externalSubs?.find((s) => s.key === key);
        if (!ext) return send(res, 404, 'not found');
        return send(res, 200, await externalToVtt(ext.file, library.cacheDir), 'text/vtt; charset=utf-8');
      }
      const idx = parseInt(key.slice(1), 10);
      if (!it.probe?.subtitles.some((s) => s.index === idx && s.text)) return send(res, 404, 'not found');
      // Embedded tracks need a full pass over the file, so cache the result.
      const cacheFile = path.join(library.cacheDir, 'thumbs', `${id}-${key}.vtt`);
      let vtt;
      try {
        vtt = await fsp.readFile(cacheFile, 'utf8');
      } catch {
        vtt = await toWebVTT(it.input, idx);
        if (!it.virtualSource) fsp.writeFile(cacheFile, vtt).catch(() => {});
      }
      send(res, 200, vtt, 'text/vtt; charset=utf-8');
    } catch (e) {
      send(res, 500, e.message);
    }
  });

  // ---------------------------------------------------------------- online subtitles
  const subtitleError = (res) => json(res, { error: 'No subtitle provider is configured. Run `shoebox config` to add an OpenSubtitles or SubDL key.' }, 501);

  route('GET', /^\/api\/subtitles\/([\w]+)\/search$/, async (req, res, [, id]) => {
    const it = library.get(id);
    if (!it) return json(res, { error: 'not found' }, 404);
    if (!subtitles?.enabled) return subtitleError(res);
    const { candidates, errors } = await subtitles.search(it);
    json(res, {
      candidates: candidates.slice(0, 30).map(({ provider, providerLabel, ref, release, lang, hashMatch, hi, machine, downloads, score }) => ({
        provider, providerLabel, ref, release, lang, hashMatch, hi, machine, downloads, score,
      })),
      errors,
    });
  });

  route('POST', /^\/api\/subtitles\/([\w]+)\/download$/, async (req, res, [, id]) => {
    const it = library.get(id);
    if (!it) return json(res, { error: 'not found' }, 404);
    if (!subtitles?.enabled) return subtitleError(res);
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    if (!body.provider || !body.ref) return json(res, { error: 'provider and ref are required' }, 400);
    try {
      const r = await subtitles.download(it, { provider: body.provider, ref: String(body.ref), lang: body.lang });
      json(res, { ...r, subtitles: library.publicItem(it).subtitles });
    } catch (e) {
      json(res, { error: e.message }, e.quota ? 429 : 502);
    }
  });

  route('POST', /^\/api\/subtitles\/([\w]+)\/auto$/, async (req, res, [, id]) => {
    const it = library.get(id);
    if (!it) return json(res, { error: 'not found' }, 404);
    if (!subtitles?.enabled) return json(res, { fetched: false, reason: 'disabled', subtitles: library.publicItem(it).subtitles });
    try {
      const r = await subtitles.auto(it);
      json(res, { ...r, subtitles: library.publicItem(it).subtitles });
    } catch (e) {
      json(res, { fetched: false, reason: e.message, subtitles: library.publicItem(it).subtitles });
    }
  });

  route('GET', /^\/thumb\/([\w]+)\.jpg$/, (req, res, [, id]) => {
    serveCached(res, library.thumbPath(id), 'image/jpeg', 86400);
  });

  route('GET', /^\/art\/([a-f0-9]{16}\.jpg)$/, (req, res, [, name]) => {
    const f = artwork.filePath(name);
    if (!f) return send(res, 404, 'not found');
    serveCached(res, f, 'image/jpeg', 86400 * 7);
  });

  // VLC / external players: M3U playlists of direct stream URLs.
  route('GET', /^\/playlist\/(show|item)\/([\w]+)\.m3u$/, (req, res, [, kind, id], url) => {
    // Prefer a raw LAN IP: external players don't always resolve .local names.
    const base = info().urls[0] || `http://${req.headers.host}`;
    let items = [];
    if (kind === 'show') {
      const show = library.shows.get(id);
      if (!show) return send(res, 404, 'not found');
      items = show.episodes.map((e) => library.get(e)).filter(Boolean);
      const season = url.searchParams.get('season');
      if (season != null) items = items.filter((i) => String(i.parsed.season ?? 1) === season);
      const from = url.searchParams.get('from');
      if (from) {
        const idx = items.findIndex((i) => i.id === from);
        if (idx > 0) items = items.slice(idx);
      }
    } else {
      const it = library.get(id);
      if (!it) return send(res, 404, 'not found');
      items = [it];
    }
    const lines = ['#EXTM3U'];
    for (const it of items) {
      lines.push(`#EXTINF:${Math.round(it.probe?.duration || -1)},${episodeLabel(library, it)}`);
      lines.push(`${base}/media/${it.id}/${encodeURIComponent(path.basename(it.rel))}`);
    }
    send(res, 200, lines.join('\n') + '\n', 'audio/x-mpegurl', {
      'content-disposition': `attachment; filename="shoebox-${kind}-${id}.m3u"`,
    });
  });

  // ---------------------------------------------------------------- torrents
  route('GET', /^\/api\/torrents$/, (req, res) => {
    json(res, { available: torrents?.available ?? false, error: torrents?.error, torrents: torrents?.list() || [] });
  });

  route('POST', /^\/api\/torrents$/, async (req, res) => {
    if (!torrents?.available) return json(res, { error: torrents?.error || 'Torrent support unavailable' }, 501);
    try {
      const buf = await readBody(req, 5 * 1024 * 1024);
      const ct = req.headers['content-type'] || '';
      let source;
      if (ct.includes('application/json')) {
        source = String(JSON.parse(buf.toString()).magnet || '').trim();
        if (!/^magnet:\?|^[a-f0-9]{40}$/i.test(source)) return json(res, { error: 'Not a magnet link' }, 400);
      } else source = buf;
      json(res, await torrents.add(source));
    } catch (e) {
      json(res, { error: e.message }, e.status || 500);
    }
  });

  route('DELETE', /^\/api\/torrents\/([a-f0-9]{40})$/, async (req, res, [, ih], url) => {
    const ok = await torrents?.remove(ih, url.searchParams.get('delete') === '1');
    json(res, { ok: !!ok });
  });

  // Raw torrent file stream, used as ffmpeg input while downloading (loopback only).
  route(['GET', 'HEAD'], /^\/api\/torrents\/([a-f0-9]{40})\/(\d+)\/raw$/, (req, res, [, ih, idx]) => {
    if (!isLoopback(req)) return send(res, 403, 'forbidden');
    const t = torrents?.get(ih);
    const file = t?.files?.[parseInt(idx, 10)];
    if (!file) return send(res, 404, 'not found');
    streamRange(req, res, {
      size: file.length,
      type: MIME[path.extname(file.name).toLowerCase()] || 'application/octet-stream',
      open: (r) => file.createReadStream({ start: r.start, end: r.end }),
    });
  });

  // ---------------------------------------------------------------- static
  route('GET', /^\/vendor\/hls\.min\.js$/, (req, res) => {
    if (!HLS_JS) return send(res, 404, 'hls.js missing');
    serveCached(res, HLS_JS, MIME['.js'], 86400);
  });

  route(['GET', 'HEAD'], /^\/.*$/, (req, res, m, url) => {
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || !path.extname(p)) p = '/index.html'; // SPA routes
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      for (const r of routes) {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        if (!methods.includes(req.method)) continue;
        const m = r.pattern.exec(url.pathname);
        if (m) return await r.handler(req, res, m, url);
      }
      send(res, 404, 'not found');
    } catch (e) {
      log(`request error ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      if (!res.headersSent) send(res, e.status || 500, e.message);
      else res.destroy();
    }
  });
  server.keepAliveTimeout = 65000;

  return {
    server,
    hls,
    close() {
      hls.shutdown();
      for (const r of sseClients) r.end();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
