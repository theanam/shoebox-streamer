// User configuration in ~/.shoebox.conf (JSON). os.homedir() resolves to %USERPROFILE% on Windows.
// A missing or unreadable file, or any field of the wrong type, falls back to the defaults.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = process.env.SHOEBOX_CONFIG || path.join(os.homedir(), '.shoebox.conf');

export const DEFAULTS = Object.freeze({
  port: 7171,
  name: 'shoebox',
  // scrypt hash of the web page password; empty = no password
  password: '',
  mdns: true,
  watch: true,
  artwork: true,
  tmdbKey: '',
  subtitles: {
    languages: ['en'],
    autoDownload: true,
    openSubtitles: { apiKey: '', username: '', password: '' },
    subdl: { apiKey: '' },
  },
});

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Copy `value` onto the shape of `def`, keeping defaults for anything missing or mistyped. */
function conform(def, value) {
  if (Array.isArray(def)) {
    return Array.isArray(value) && value.every((x) => typeof x === typeof def[0]) && value.length ? [...value] : [...def];
  }
  if (def && typeof def === 'object') {
    const out = {};
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const k of Object.keys(def)) out[k] = conform(def[k], src[k]);
    return out;
  }
  if (typeof def === 'number') return Number.isFinite(value) ? value : def;
  return typeof value === typeof def ? value : def;
}

/** @returns {{ config: object, path: string, status: 'loaded'|'missing'|'corrupt', error?: string }} */
export function loadConfig(file = CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { config: clone(DEFAULTS), path: file, status: 'missing', error: e.code === 'ENOENT' ? undefined : e.message };
  }
  try {
    const config = conform(DEFAULTS, JSON.parse(text));
    if (config.port < 1 || config.port > 65535) config.port = DEFAULTS.port;
    config.subtitles.languages = config.subtitles.languages.map((l) => l.trim().toLowerCase()).filter(Boolean);
    if (!config.subtitles.languages.length) config.subtitles.languages = [...DEFAULTS.subtitles.languages];
    return { config, path: file, status: 'loaded' };
  } catch (e) {
    return { config: clone(DEFAULTS), path: file, status: 'corrupt', error: e.message };
  }
}

/** Write atomically, readable only by the current user (the file can hold passwords and API keys). */
export function saveConfig(config, file = CONFIG_PATH) {
  const data = JSON.stringify(conform(DEFAULTS, config), null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

export function mask(secret) {
  if (!secret) return '';
  return secret.length <= 6 ? '•'.repeat(secret.length) : '•'.repeat(Math.min(12, secret.length - 4)) + secret.slice(-4);
}

/** Config with secrets masked, for display. */
export function redacted(config) {
  const c = clone(config);
  c.password = c.password ? '(set)' : '';
  c.tmdbKey = mask(c.tmdbKey);
  c.subtitles.openSubtitles.apiKey = mask(c.subtitles.openSubtitles.apiKey);
  c.subtitles.openSubtitles.password = mask(c.subtitles.openSubtitles.password);
  c.subtitles.subdl.apiKey = mask(c.subtitles.subdl.apiKey);
  return c;
}
