export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Tagged template that escapes interpolations unless wrapped with raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v == null || v === false) return;
      if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.s : esc(x))).join('');
      else out += v && v.__raw ? v.s : esc(v);
    }
  });
  return { __raw: true, s: out };
}
export const raw = (s) => ({ __raw: true, s });

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function epCode(it) {
  if (it.season == null) return '';
  const e = it.episodeEnd ? `E${pad(it.episode)}-E${pad(it.episodeEnd)}` : `E${pad(it.episode)}`;
  return `S${pad(it.season)}${e}`;
}
const pad = (n) => String(n ?? 0).padStart(2, '0');

/** Fuzzy subsequence score; higher is better, -1 for no match. */
export function fuzzy(query, text) {
  query = query.toLowerCase().replace(/\s+/g, ' ').trim();
  text = text.toLowerCase();
  if (!query) return 0;
  const idx = text.indexOf(query);
  if (idx >= 0) return 1000 - idx + (idx === 0 || text[idx - 1] === ' ' ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = text.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 + (found === 0 || text[found - 1] === ' ' ? 15 : 0) - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

export function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'content-type': 'application/json', ...(opts.headers || {}) } : opts.headers,
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || res.statusText);
  return body;
}

export function toast(msg, { action, onAction, timeout = 4000 } = {}) {
  let host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => (onAction?.(), el.remove());
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
