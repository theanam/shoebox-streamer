// `shoebox config`: interactive setup that writes ~/.shoebox.conf.

import readline from 'node:readline';
import { loadConfig, saveConfig, mask, redacted, CONFIG_PATH, DEFAULTS } from './config.js';
import { OpenSubtitles, SubDL } from './subtitles.js';
import { toIso1, languageName } from './lang.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  b: (s) => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[39m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[39m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[39m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[39m` : s),
};

class Prompter {
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    this.muted = false;
    // Hide typed characters for secrets.
    const write = this.rl._writeToOutput.bind(this.rl);
    this.rl._writeToOutput = (s) => {
      if (!this.muted) return write(s);
      if (s.includes('\n') || s.includes('\r')) write('\n');
      else write('•'.repeat(s.length === 1 ? 1 : 0));
    };
    const cancel = () => {
      console.log(c.yellow('\n\n  Cancelled. Nothing was saved.\n'));
      process.exit(130);
    };
    this.rl.on('SIGINT', cancel);
    // Queue lines so answers typed (or pasted) ahead of their question aren't lost.
    this.lines = [];
    this.waiting = null;
    this.rl.on('line', (l) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(l);
      } else this.lines.push(l);
    });
    this.rl.on('close', () => {
      if (!this.closing) cancel();
    });
  }
  ask(q, { secret = false } = {}) {
    process.stdout.write(q);
    this.muted = secret;
    return new Promise((resolve) => {
      const done = (a) => {
        this.muted = false;
        resolve(a.trim());
      };
      if (this.lines.length) done(this.lines.shift());
      else this.waiting = done;
    });
  }
  close() {
    this.closing = true;
    this.rl.close();
  }
}

/** Prompt for a value; Enter keeps the current one, "-" clears it. */
async function text(p, label, current, { secret = false, help } = {}) {
  if (help) console.log(c.dim(`    ${help}`));
  const shown = current ? (secret ? mask(current) : current) : c.dim('none');
  const a = await p.ask(`  ${label} [${shown}]: `, { secret });
  if (a === '') return current;
  if (a === '-') return '';
  return a;
}

async function yesNo(p, label, current) {
  for (;;) {
    const a = (await p.ask(`  ${label} [${current ? 'Y/n' : 'y/N'}]: `)).toLowerCase();
    if (a === '') return current;
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
    console.log(c.red('    Please answer y or n.'));
  }
}

async function number(p, label, current, min, max) {
  for (;;) {
    const a = await p.ask(`  ${label} [${current}]: `);
    if (a === '') return current;
    const n = Number(a);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    console.log(c.red(`    Enter a whole number between ${min} and ${max}.`));
  }
}

async function languages(p, current) {
  console.log(c.dim('    Comma-separated, most preferred first, e.g. "en" or "en, es, bn". Names work too ("English").'));
  for (;;) {
    const a = await p.ask(`  Subtitle languages [${current.join(', ')}]: `);
    if (a === '') return current;
    const parts = a.split(/[,\s]+/).filter(Boolean);
    const codes = parts.map(toIso1);
    const bad = parts.filter((_, i) => !codes[i]);
    if (bad.length) {
      console.log(c.red(`    Unknown language: ${bad.join(', ')}`));
      continue;
    }
    const uniq = [...new Set(codes)];
    console.log(c.dim(`    → ${uniq.map(languageName).join(', ')}`));
    return uniq;
  }
}

function section(title) {
  console.log(`\n  ${c.b(title)}`);
}

export async function runWizard() {
  if (!process.stdin.isTTY) {
    console.error(`shoebox config needs an interactive terminal. You can also edit ${CONFIG_PATH} by hand (JSON).`);
    process.exit(1);
  }
  const { config, status, error } = loadConfig();
  console.log(`\n  ${c.b('📦 Shoebox setup')}`);
  console.log(c.dim(`  Settings file: ${CONFIG_PATH}`));
  if (status === 'corrupt') console.log(c.yellow(`  The existing file couldn't be read (${error}), so starting from defaults.`));
  console.log(c.dim('  Press Enter to keep the value in [brackets]. Type - to clear a value. Ctrl+C quits without saving.'));

  const p = new Prompter();
  const cfg = JSON.parse(JSON.stringify(config));

  section('Server');
  cfg.port = await number(p, 'Port', cfg.port, 1, 65535);
  cfg.name = (await text(p, 'Network name (http://<name>.local)', cfg.name)) || DEFAULTS.name;
  while (!/^[a-z0-9-]{1,63}$/i.test(cfg.name)) {
    console.log(c.red('    Use letters, digits and dashes only.'));
    cfg.name = (await text(p, 'Network name', DEFAULTS.name)) || DEFAULTS.name;
  }
  cfg.mdns = await yesNo(p, `Announce as ${cfg.name}.local on the network`, cfg.mdns);
  cfg.watch = await yesNo(p, 'Watch the folder for new videos', cfg.watch);

  section('Artwork');
  cfg.artwork = await yesNo(p, 'Fetch posters online (TVMaze, Wikipedia)', cfg.artwork);
  if (cfg.artwork) {
    cfg.tmdbKey = await text(p, 'TMDB API key (optional)', cfg.tmdbKey, {
      secret: true,
      help: 'Optional, for better posters: themoviedb.org → Settings → API.',
    });
  }

  section('Subtitles');
  console.log(c.dim('    Subtitles inside the video or next to it are always used first.'));
  console.log(c.dim('    Online search only runs when none of those is in your languages.'));
  const sc = cfg.subtitles;
  sc.languages = await languages(p, sc.languages);
  const os = sc.openSubtitles;
  os.apiKey = await text(p, 'OpenSubtitles API key', os.apiKey, {
    secret: true,
    help: 'Free: sign up at opensubtitles.com, then Profile → API consumers → New consumer.',
  });
  if (os.apiKey) {
    os.username = await text(p, 'OpenSubtitles username (optional)', os.username, {
      help: 'Logging in raises the free download limit (about 5 → 20 per day).',
    });
    if (os.username) os.password = await text(p, 'OpenSubtitles password', os.password, { secret: true });
    else os.password = '';
  }
  sc.subdl.apiKey = await text(p, 'SubDL API key', sc.subdl.apiKey, {
    secret: true,
    help: 'Free, with much higher limits: sign up at subdl.com, then Profile → API key.',
  });
  if (os.apiKey || sc.subdl.apiKey) {
    sc.autoDownload = await yesNo(p, 'Download missing subtitles automatically when you play something', sc.autoDownload);
  }

  if ((os.apiKey || sc.subdl.apiKey) && (await yesNo(p, 'Test the subtitle keys now', true))) {
    const checks = [];
    if (os.apiKey) checks.push(['OpenSubtitles', new OpenSubtitles(os)]);
    if (sc.subdl.apiKey) checks.push(['SubDL', new SubDL(sc.subdl)]);
    for (const [label, provider] of checks) {
      try {
        console.log(`    ${c.green('✓')} ${label}: ${await provider.test()}`);
      } catch (e) {
        console.log(`    ${c.red('✗')} ${label}: ${e.status === 401 || e.status === 403 ? 'key or login rejected' : e.message}`);
      }
    }
  }

  section('Summary');
  console.log(
    JSON.stringify(redacted(cfg), null, 2)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')
  );
  const save = await yesNo(p, `Save to ${CONFIG_PATH}`, true);
  p.close();
  if (!save) {
    console.log(c.yellow('\n  Not saved.\n'));
    return;
  }
  saveConfig(cfg);
  console.log(c.green(`\n  Saved. Run ${c.b('shoebox')} in a folder of videos to start.\n`));
}

export function showConfig() {
  const { config, status, error, path } = loadConfig();
  console.log(c.dim(`# ${path} (${status === 'loaded' ? 'loaded' : status === 'missing' ? 'not created yet, showing defaults' : `unreadable: ${error}; showing defaults`})`));
  console.log(JSON.stringify(redacted(config), null, 2));
}
