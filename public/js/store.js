// Per-browser persistence: watch progress and settings (localStorage, failure-tolerant).

const P_KEY = 'shoebox:progress';
const S_KEY = 'shoebox:settings';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

let progress = read(P_KEY, {});

export const WATCHED_AT = 0.92;

export function getProgress(id) {
  return progress[id];
}
export function allProgress() {
  return progress;
}
export function setProgress(id, t, d) {
  if (!d || !isFinite(d)) return;
  const watched = t / d >= WATCHED_AT || progress[id]?.watched;
  progress[id] = { t: Math.round(t), d: Math.round(d), at: Date.now(), watched: !!watched };
  write(P_KEY, progress);
}
export function markWatched(id, watched = true, d) {
  const p = progress[id] || { t: 0, d: d || 0 };
  progress[id] = { ...p, t: watched ? p.d || p.t : 0, watched, at: Date.now() };
  write(P_KEY, progress);
}
export function clearProgress(id) {
  delete progress[id];
  write(P_KEY, progress);
}
/** 0..1 fraction watched, or 0. */
export function fraction(id) {
  const p = progress[id];
  if (!p) return 0;
  if (p.watched) return 1;
  return p.d ? Math.min(1, p.t / p.d) : 0;
}
export function inProgress(id) {
  const p = progress[id];
  return !!p && !p.watched && p.t > 15 && p.d && p.t / p.d < WATCHED_AT;
}

const DEFAULT_SETTINGS = { theme: 'dark', autoplayNext: true, quality: 'auto', speed: 1, volume: 1, muted: false, subtitleLang: null };
let settings = { ...DEFAULT_SETTINGS, ...read(S_KEY, {}) };
export function getSetting(k) {
  return settings[k];
}
export function setSetting(k, v) {
  settings[k] = v;
  write(S_KEY, settings);
}

export function clientId() {
  let id = read('shoebox:client', null);
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    write('shoebox:client', id);
  }
  return id;
}
