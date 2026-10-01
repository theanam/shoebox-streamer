#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exec } from 'node:child_process';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const HELP = `
shoebox ${pkg.version}: stream a folder of videos to any device on your network

Usage:
  shoebox [folder]                serve a folder (default: current directory)
  shoebox "magnet:?xt=..."        serve the current folder and start downloading a torrent
  shoebox movie.torrent           same, from a .torrent file

Options:
  -p, --port <n>       port to listen on (default 7171, next free port if taken)
  -n, --name <name>    mDNS name, reachable as http://<name>.local (default "shoebox")
      --host <addr>    interface to bind (default 0.0.0.0, all interfaces)
      --open           open the web UI in this computer's browser
      --no-mdns        don't advertise on the local network via mDNS/Bonjour
      --no-watch       don't watch the folder for new files
      --offline        don't fetch poster art from the internet
      --tmdb-key <k>   TMDB API key for better movie/show posters (or env TMDB_API_KEY)
  -v, --verbose        log every ffmpeg job
  -h, --help           show this help
      --version        show version
`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      name: { type: 'string', short: 'n', default: 'shoebox' },
      host: { type: 'string', default: '0.0.0.0' },
      open: { type: 'boolean', default: false },
      'no-mdns': { type: 'boolean', default: false },
      'no-watch': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      'tmdb-key': { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
} catch (e) {
  console.error(e.message + '\n' + HELP);
  process.exit(1);
}
const opts = args.values;
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
if (opts.version) {
  console.log(pkg.version);
  process.exit(0);
}

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[22m`, dim: (s) => `\x1b[2m${s}\x1b[22m`, cyan: (s) => `\x1b[36m${s}\x1b[39m`, yellow: (s) => `\x1b[33m${s}\x1b[39m`, red: (s) => `\x1b[31m${s}\x1b[39m`, green: (s) => `\x1b[32m${s}\x1b[39m` }
  : new Proxy({}, { get: () => (s) => s });

// Positionals: folder, magnet links and .torrent files in any order.
let root = process.cwd();
const torrentSources = [];
for (const p of args.positionals) {
  if (/^magnet:\?/i.test(p) || /^[a-f0-9]{40}$/i.test(p)) torrentSources.push(p);
  else if (p.toLowerCase().endsWith('.torrent') && fs.existsSync(p)) torrentSources.push(fs.readFileSync(p));
  else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) root = path.resolve(p);
  else {
    console.error(c.red(`Not a folder, magnet link or .torrent file: ${p}`));
    process.exit(1);
  }
}

const { FFMPEG, FFPROBE } = await import('../src/ffmpeg.js');
if (!FFMPEG || !FFPROBE) {
  console.error(
    c.red('ffmpeg/ffprobe not found.') +
      ' Install ffmpeg (e.g. `brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install ffmpeg`)\n' +
      'or reinstall shoebox-streamer with optional dependencies enabled.'
  );
  process.exit(1);
}

const verbose = opts.verbose;
const log = (msg, isVerbose = false) => {
  if (isVerbose && !verbose) return;
  console.log(c.dim(`[${new Date().toLocaleTimeString()}]`) + ' ' + msg);
};

const { Library } = await import('../src/library.js');
const { Artwork } = await import('../src/artwork.js');
const { createApp } = await import('../src/server.js');
const { publish } = await import('../src/mdns.js');
const { Torrents } = await import('../src/torrent.js');
const { pickEncoder } = await import('../src/ffmpeg.js');

const library = new Library(root, { log });
const artwork = new Artwork(library.cacheDir, {
  offline: opts.offline,
  tmdbKey: opts['tmdb-key'] || process.env.TMDB_API_KEY,
  log: (m) => log(m, true),
});
library.artwork = artwork;

let port = parseInt(opts.port || process.env.PORT || '7171', 10);
const torrents = new Torrents({ library, getPort: () => port, log });
let mdns = null;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^(docker|veth|br-|utun|awdl|llw|bridge|vboxnet|vmnet)/.test(name)) out.push(a.address);
    }
  }
  return out;
}

const info = () => ({
  version: pkg.version,
  name: path.basename(root),
  root,
  port,
  mdns: mdns ? `http://${mdns.host}:${port}` : null,
  urls: lanAddresses().map((a) => `http://${a}:${port}`),
});

const app = createApp({ library, artwork, torrents, info, log });

function listen(p, attempts = 20) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      app.server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && attempts > 1 && !opts.port) resolve(listen(p + 1, attempts - 1));
      else reject(e);
    };
    const onListening = () => {
      app.server.off('error', onError);
      resolve(p);
    };
    app.server.once('error', onError);
    app.server.once('listening', onListening);
    app.server.listen(p, opts.host);
  });
}

try {
  port = await listen(port);
} catch (e) {
  console.error(c.red(`Could not listen on port ${port}: ${e.message}`));
  process.exit(1);
}

if (!opts['no-mdns']) mdns = publish({ name: opts.name, port, log: (m) => log(m, true) });

const urls = info().urls;
const primary = mdns ? `http://${mdns.host}:${port}` : urls[0] || `http://localhost:${port}`;
console.log();
console.log(`  ${c.b('📦 Shoebox')} ${c.dim('v' + pkg.version)}  serving ${c.cyan(root)}`);
console.log();
if (mdns) console.log(`  ${c.b('Network name:')} ${c.green(primary)}`);
for (const u of urls) console.log(`  ${c.b('On your LAN:')}  ${c.green(u)}`);
console.log(`  ${c.b('This computer:')} http://localhost:${port}`);
console.log();
try {
  const qr = require('qrcode-terminal');
  // Phones resolve the raw IP most reliably; QR-encode that.
  qr.generate(urls[0] || primary, { small: true }, (code) => {
    console.log(code.split('\n').map((l) => '  ' + l).join('\n'));
    console.log(c.dim(`  Scan to open on your phone: ${urls[0] || primary}`));
    console.log();
  });
} catch {}

pickEncoder().then((enc) => log(`Video encoder: ${enc === 'libx264' ? 'libx264 (software)' : enc + ' (hardware)'}`));

await library.scan();
if (!opts['no-watch']) library.watch();

await torrents.init();
if (torrentSources.length) {
  if (!torrents.available) log(c.yellow(torrents.error));
  for (const src of torrentSources) {
    torrents
      .add(src)
      .then((t) => log(`Added torrent: ${t.name}`))
      .catch((e) => log(c.red(`Could not add torrent: ${e.message}`)));
  }
}

if (opts.open) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} http://localhost:${port}`);
}

// A bug in an optional subsystem (torrents, mDNS) must not take the video server down.
process.on('uncaughtException', (e) => log(c.red(`Unexpected error: ${e.stack || e.message}`)));
process.on('unhandledRejection', (e) => log(c.red(`Unhandled rejection: ${e?.stack || e}`), true));

let closing = false;
async function shutdown() {
  if (closing) process.exit(1);
  closing = true;
  console.log('\n  Shutting down…');
  setTimeout(() => process.exit(0), 3000).unref();
  await Promise.allSettled([app.close(), mdns?.stop(), torrents.shutdown()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
