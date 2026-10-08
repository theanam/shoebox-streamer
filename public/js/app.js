import { $, $$, html, raw, esc, api, fmtDuration, fmtBytes, fmtTime, epCode, fuzzy, hue, toast, copyText } from './util.js';
import { icons } from './icons.js';
import * as store from './store.js';
import { Player } from './player.js';

const app = $('#app');
const state = {
  lib: { shows: [], items: [] },
  items: new Map(),
  shows: new Map(),
  info: null,
  query: '',
  route: null,
  player: null,
  torrentTimer: null,
  scroll: new Map(),
};

// ------------------------------------------------------------------ data
async function loadLibrary() {
  const lib = await api('/api/library');
  state.lib = lib;
  state.items = new Map(lib.items.map((i) => [i.id, i]));
  state.shows = new Map(lib.shows.map((s) => [s.id, s]));
  return lib;
}

export function streamBase() {
  // Prefer a raw LAN IP for external players: not every app resolves .local names.
  const port = location.port || (location.protocol === 'https:' ? 443 : 80);
  const lan = state.info?.urls?.find((u) => u.endsWith(':' + port));
  return lan || location.origin;
}

export function externalLinks(item) {
  let url = `${streamBase()}/media/${item.id}/${encodeURIComponent(item.rel.split('/').pop())}`;
  // VLC can't sign in, so password-protected links carry a media key.
  if (state.info?.mediaKey) url += `?k=${encodeURIComponent(state.info.mediaKey)}`;
  const ua = navigator.userAgent;
  const vlc = /Android/i.test(ua)
    ? `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=http;package=org.videolan.vlc;type=video/*;end`
    : `vlc://${url}`;
  return { url, vlc };
}

function showEpisodes(show) {
  return show.episodes.map((id) => state.items.get(id)).filter(Boolean);
}

/** Next episode to watch for a show (first unwatched after last activity). */
function nextUp(show) {
  const eps = showEpisodes(show);
  let lastIdx = -1;
  let lastAt = 0;
  eps.forEach((e, i) => {
    const p = store.getProgress(e.id);
    if (p && p.at > lastAt) {
      lastAt = p.at;
      lastIdx = i;
    }
  });
  if (lastIdx < 0) return { item: eps.find((e) => !store.getProgress(e.id)?.watched) || eps[0], at: 0 };
  const last = eps[lastIdx];
  if (!store.getProgress(last.id)?.watched) return { item: last, at: lastAt };
  const next = eps.slice(lastIdx + 1).find((e) => !store.getProgress(e.id)?.watched);
  return { item: next || null, at: lastAt };
}

function continueWatching() {
  const out = [];
  for (const show of state.lib.shows) {
    const { item, at } = nextUp(show);
    if (item && at) out.push({ item, at, show });
  }
  for (const it of state.lib.items) {
    if (it.kind === 'movie' && store.inProgress(it.id)) out.push({ item: it, at: store.getProgress(it.id).at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 20);
}

// ------------------------------------------------------------------ rendering helpers
function placeholder(name) {
  const h = hue(name);
  return html`<div class="placeholder" style="background:linear-gradient(135deg,hsl(${h} 45% 32%),hsl(${(h + 50) % 360} 55% 18%))">${name}</div>`;
}

function showCard(show) {
  const first = state.items.get(show.episodes[0]);
  const eps = showEpisodes(show);
  const watched = eps.filter((e) => store.getProgress(e.id)?.watched).length;
  let art;
  if (show.poster) art = html`<div class="art"><img loading="lazy" src="${show.poster}" alt="" /></div>`;
  else if (first?.thumb) art = html`<div class="art frame"><img loading="lazy" src="/thumb/${first.id}.jpg" alt="" /><div class="frame-title">${show.name}</div></div>`;
  else art = html`<div class="art">${placeholder(show.name)}</div>`;
  const badge =
    watched === eps.length && eps.length
      ? html`<span class="badge ok">✓</span>`
      : watched
        ? html`<span class="badge">${eps.length - watched} left</span>`
        : html`<span class="badge">${eps.length} ep</span>`;
  const seasons = show.seasons.filter((s) => s !== 0).length;
  return html`<a class="poster" href="#/show/${show.id}">
    <div style="position:relative">${art}${badge}</div>
    <div class="meta"><div class="title">${show.name}</div>
    <div class="sub">${seasons > 1 ? `${seasons} seasons · ` : ''}${eps.length} episode${eps.length === 1 ? '' : 's'}</div></div>
  </a>`;
}

function movieCard(it) {
  const f = store.fraction(it.id);
  let art;
  if (it.poster) art = html`<div class="art"><img loading="lazy" src="${it.poster}" alt="" /></div>`;
  else if (it.thumb) art = html`<div class="art frame"><img loading="lazy" src="/thumb/${it.id}.jpg" alt="" /><div class="frame-title">${it.title}</div></div>`;
  else art = html`<div class="art">${placeholder(it.title)}</div>`;
  return html`<a class="poster" href="#/watch/${it.id}">
    <div style="position:relative">${art}
      ${f >= 1 ? html`<span class="badge ok">✓</span>` : it.torrent ? html`<span class="badge accent">${Math.round(it.torrent.progress * 100)}%</span>` : ''}
      ${f > 0 && f < 1 ? html`<div class="progress" style="border-radius:0 0 12px 12px;overflow:hidden"><i style="width:${(f * 100).toFixed(1)}%"></i></div>` : ''}
    </div>
    <div class="meta"><div class="title">${it.title}</div>
    <div class="sub">${[it.year, fmtDuration(it.duration)].filter(Boolean).join(' · ')}</div></div>
  </a>`;
}

function thumbImg(it) {
  return it.thumb
    ? html`<img loading="lazy" src="/thumb/${it.id}.jpg" alt="" />`
    : placeholder(it.kind === 'episode' ? epCode(it) : it.title);
}

function wideCard({ item, show }) {
  const f = store.fraction(item.id);
  const p = store.getProgress(item.id);
  const title = show ? show.name : item.title;
  const sub = show
    ? `${epCode(item)}${item.title ? ' · ' + item.title : ''}`
    : p
      ? `${fmtTime(item.duration - p.t)} left`
      : fmtDuration(item.duration);
  return html`<a class="wide" href="#/watch/${item.id}">
    <div class="thumb">${thumbImg(item)}<div class="play-hint">${raw(icons.play)}</div>
      ${f > 0 && f < 1 ? html`<div class="progress"><i style="width:${(f * 100).toFixed(1)}%"></i></div>` : ''}
    </div>
    <div class="body"><div class="title">${title}</div><div class="sub">${f > 0 && f < 1 ? '' : 'Up next · '}${sub}</div></div>
  </a>`;
}

export function episodeRow(it, { current = false, compact = false } = {}) {
  const f = store.fraction(it.id);
  const watched = store.getProgress(it.id)?.watched;
  return html`<div class="episode ${current ? 'current' : ''}" data-id="${it.id}">
    <a class="thumb" href="#/watch/${it.id}" style="border-radius:8px">${thumbImg(it)}<div class="play-hint">${raw(icons.play)}</div>
      ${f > 0 && f < 1 ? html`<div class="progress"><i style="width:${(f * 100).toFixed(1)}%"></i></div>` : ''}
    </a>
    <a href="#/watch/${it.id}" style="min-width:0">
      <div class="ep-code">${epCode(it)}${it.torrent ? html` · <span style="color:var(--text-3)">${Math.round(it.torrent.progress * 100)}% downloaded</span>` : ''}</div>
      <div class="ep-title">${it.title || `Episode ${it.episode}`}</div>
      <div class="ep-sub">${fmtDuration(it.duration)}${it.height ? ` · ${it.height}p` : ''}${watched ? html` · <span class="watched">Watched</span>` : ''}</div>
      ${compact ? '' : html`<div class="ep-sub file">${it.rel}</div>`}
    </a>
    ${compact ? '' : html`<div class="ep-actions"><button class="icon-btn" data-menu="${it.id}" aria-label="More">${raw(icons.more)}</button></div>`}
  </div>`;
}

// ------------------------------------------------------------------ menus
let openMenuEl = null;
function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
export function openMenu(anchor, entries) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'menu';
  for (const e of entries) {
    if (!e) continue;
    if (e === 'hr') {
      el.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement(e.href ? 'a' : 'button');
    if (e.href) {
      b.href = e.href;
      if (e.download) b.setAttribute('download', '');
      if (e.target) b.target = e.target;
    }
    b.innerHTML = `${e.icon || ''}<span>${esc(e.label)}</span>`;
    b.onclick = (ev) => {
      if (!e.href) ev.preventDefault();
      closeMenu();
      e.onClick?.();
    };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12)) + 'px';
  el.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(12, r.top - h - 6) : r.bottom + 6) + 'px';
  openMenuEl = el;
  setTimeout(() => document.addEventListener('pointerdown', onOutside, { once: true }), 0);
  function onOutside(ev) {
    if (!el.contains(ev.target)) closeMenu();
    else document.addEventListener('pointerdown', onOutside, { once: true });
  }
}

function itemMenu(anchor, it) {
  const ext = externalLinks(it);
  const watched = store.getProgress(it.id)?.watched;
  const entries = [
    { icon: icons.play, label: 'Play', href: `#/watch/${it.id}` },
    store.getProgress(it.id) && !watched
      ? { icon: icons.refresh, label: 'Play from beginning', onClick: () => (store.clearProgress(it.id), (location.hash = `#/watch/${it.id}`)) }
      : null,
    {
      icon: icons.check,
      label: watched ? 'Mark as unwatched' : 'Mark as watched',
      onClick: () => (store.markWatched(it.id, !watched, it.duration), render()),
    },
    'hr',
    { icon: icons.vlc, label: 'Open in VLC', href: ext.vlc },
    it.showId
      ? { icon: icons.list, label: 'VLC playlist from here (.m3u)', href: `/playlist/show/${it.showId}.m3u?from=${it.id}`, download: true }
      : { icon: icons.list, label: 'VLC playlist (.m3u)', href: `/playlist/item/${it.id}.m3u`, download: true },
    { icon: icons.link, label: 'Copy stream URL', onClick: async () => toast((await copyText(ext.url)) ? 'Stream URL copied' : ext.url) },
  ].filter(Boolean);
  openMenu(anchor, entries);
}

function appMenu(anchor) {
  const theme = store.getSetting('theme');
  openMenu(anchor, [
    { icon: theme === 'dark' ? icons.sun : icons.moon, label: theme === 'dark' ? 'Light theme' : 'Dark theme', onClick: toggleTheme },
    { icon: icons.magnet, label: 'Torrents', href: '#/torrents' },
    { icon: icons.refresh, label: 'Rescan library', onClick: () => api('/api/rescan', { method: 'POST' }).then(() => toast('Rescanning…')) },
    { icon: icons.link, label: 'Server addresses', onClick: showAddresses },
    state.info?.auth?.enabled
      ? { icon: icons.close, label: 'Sign out', onClick: () => api('/api/logout', { method: 'POST' }).finally(() => location.reload()) }
      : null,
    'hr',
    {
      icon: icons.trash,
      label: state.info?.syncWatchtime ? 'Clear watch history (all devices)' : 'Clear watch history (this device)',
      onClick: async () => {
        const all = state.info?.syncWatchtime;
        if (!confirm(all ? 'Clear watch progress on every device using this Shoebox?' : 'Clear all watch progress on this device?')) return;
        if (all) await api('/api/progress/clear', { method: 'POST' }).catch(() => {});
        localStorage.removeItem('shoebox:progress');
        location.reload();
      },
    },
  ]);
}

function showAddresses() {
  const i = state.info;
  if (!i) return;
  const list = [i.mdns, ...i.urls].filter(Boolean);
  toast(list.join('  ·  ') + (i.encoder ? `  ·  encoder: ${i.encoder}` : ''), { timeout: 9000, action: 'Copy', onAction: () => copyText(list[0]) });
}

function toggleTheme() {
  const next = store.getSetting('theme') === 'dark' ? 'light' : 'dark';
  store.setSetting('theme', next);
  document.documentElement.dataset.theme = next;
  $('meta[name=theme-color]').content = next === 'dark' ? '#0e0c0d' : '#faf7f7';
  renderTopbar();
}

// ------------------------------------------------------------------ views
function renderTopbar() {
  const theme = store.getSetting('theme');
  const torrentsActive = state.lib.items.some((i) => i.torrent);
  const bar = html`<header class="topbar">
    <a class="brand" href="#/"><img src="/icon.svg" alt="" />Shoebox<small>${state.lib.name || ''}</small></a>
    <label class="search">${raw(icons.search)}<input id="q" type="search" placeholder="Search shows, movies, episodes" value="${state.query}" autocomplete="off" /></label>
    <a class="icon-btn" href="#/torrents" title="Torrents">${raw(icons.magnet)}${torrentsActive ? raw('<span class="dot"></span>') : ''}</a>
    <button class="icon-btn" id="theme-btn" title="Toggle theme">${raw(theme === 'dark' ? icons.sun : icons.moon)}</button>
    <button class="icon-btn" id="app-menu" title="More">${raw(icons.more)}</button>
  </header>`;
  let header = $('header.topbar');
  const tmp = document.createElement('div');
  tmp.innerHTML = bar.s;
  const fresh = tmp.firstElementChild;
  if (header) {
    // Keep the search input (and its focus/caret) intact.
    const q = $('#q', header);
    fresh.querySelector('#q').replaceWith(q);
    header.replaceWith(fresh);
  } else app.before(fresh);
  $('#theme-btn').onclick = toggleTheme;
  $('#app-menu').onclick = (e) => appMenu(e.currentTarget);
  const q = $('#q');
  q.oninput = () => {
    state.query = q.value;
    if (state.route?.name !== 'home') location.hash = '#/';
    else render();
  };
}

function statusChip() {
  const p = state.lib.pending || {};
  const parts = [];
  if (state.lib.scanning) parts.push('Scanning folder');
  if (p.probe) parts.push(`Reading ${p.probe} file${p.probe > 1 ? 's' : ''}`);
  if (p.thumbs) parts.push(`Generating ${p.thumbs} thumbnail${p.thumbs > 1 ? 's' : ''}`);
  if (p.art) parts.push('Fetching artwork');
  if (!parts.length) return '';
  return html`<div class="status-chip"><span class="spinner"></span>${parts.join(' · ')}…</div>`;
}

function viewHome() {
  const { shows, items } = state.lib;
  const movies = items.filter((i) => i.kind === 'movie');
  if (!items.length && !state.lib.scanning) {
    return html`<div class="empty">
      <h2>No videos found</h2>
      <p>Shoebox is serving <code>${state.lib.root}</code>, but it has no video files yet.</p>
      <p>Drop some files in (they show up automatically) or <a href="#/torrents" style="color:var(--accent)">add a torrent</a>.</p>
    </div>`;
  }
  const q = state.query.trim();
  if (q) {
    const scored = [];
    for (const s of shows) {
      const sc = fuzzy(q, s.name);
      if (sc >= 0) scored.push({ sc: sc + 50, el: showCard(s), kind: 'show' });
    }
    for (const m of movies) {
      const sc = fuzzy(q, `${m.title} ${m.year || ''}`);
      if (sc >= 0) scored.push({ sc, el: movieCard(m), kind: 'movie' });
    }
    const eps = [];
    for (const it of items) {
      if (it.kind !== 'episode') continue;
      const show = state.shows.get(it.showId);
      const sc = fuzzy(q, `${show?.name || ''} ${epCode(it)} ${it.title || ''}`);
      if (sc >= 0) eps.push({ sc, it });
    }
    scored.sort((a, b) => b.sc - a.sc);
    eps.sort((a, b) => b.sc - a.sc);
    return html`
      <section class="section"><div class="section-head"><h2>Results for “${q}”</h2><span class="count">${scored.length + eps.length}</span></div>
      ${scored.length ? html`<div class="grid">${scored.slice(0, 60).map((x) => x.el)}</div>` : ''}
      </section>
      ${eps.length ? html`<section class="section"><div class="section-head"><h2>Episodes</h2></div><div class="episodes">${eps.slice(0, 40).map((e) => episodeRow(e.it))}</div></section>` : ''}
      ${!scored.length && !eps.length ? html`<p style="color:var(--text-3)">Nothing matches.</p>` : ''}`;
  }
  const cw = continueWatching();
  const sortedShows = [...shows].sort((a, b) => a.name.localeCompare(b.name));
  const sortedMovies = [...movies].sort((a, b) => a.title.localeCompare(b.title));
  return html`
    ${statusChip()}
    ${cw.length ? html`<section class="section"><div class="section-head"><h2>Continue watching</h2></div><div class="row">${cw.map(wideCard)}</div></section>` : ''}
    ${shows.length ? html`<section class="section"><div class="section-head"><h2>Shows</h2><span class="count">${shows.length}</span></div><div class="grid">${sortedShows.map(showCard)}</div></section>` : ''}
    ${movies.length ? html`<section class="section"><div class="section-head"><h2>Movies</h2><span class="count">${movies.length}</span></div><div class="grid">${sortedMovies.map(movieCard)}</div></section>` : ''}
  `;
}

function viewShow(id, season) {
  const show = state.shows.get(id);
  if (!show) return html`<div class="empty"><h2>Show not found</h2><a class="btn" href="#/">Back to library</a></div>`;
  const eps = showEpisodes(show);
  const { item: up } = nextUp(show);
  const seasons = show.seasons;
  const sel = season != null && seasons.includes(season) ? season : up ? (up.season ?? seasons[0]) : seasons[0];
  const list = eps.filter((e) => (e.season ?? 1) === sel);
  const bgSrc = show.poster || (eps[0]?.thumb ? `/thumb/${eps[0].id}.jpg` : null);
  const total = eps.reduce((a, e) => a + (e.duration || 0), 0);
  const upP = up && store.getProgress(up.id);
  return html`
    <a class="back-link" href="#/">${raw(icons.arrowLeft)} Library</a>
    <div class="hero">
      ${bgSrc ? html`<div class="hero-bg"><img src="${bgSrc}" alt="" /></div>` : ''}
      <div class="poster"><div class="art">${show.poster ? html`<img src="${show.poster}" alt="" />` : eps[0]?.thumb ? html`<img src="/thumb/${eps[0].id}.jpg" alt="" style="object-fit:cover" />` : placeholder(show.name)}</div></div>
      <div>
        <h1>${show.name}</h1>
        <div class="facts">${seasons.filter((s) => s).length} season${seasons.filter((s) => s).length === 1 ? '' : 's'} · ${eps.length} episodes · ${fmtDuration(total)}</div>
        ${show.overview ? html`<p class="overview">${show.overview}</p>` : ''}
        <div class="actions">
          ${up ? html`<a class="btn primary" href="#/watch/${up.id}">${raw(icons.play)} ${upP && !upP.watched && upP.t > 15 ? 'Resume' : 'Play'} ${epCode(up)}</a>` : ''}
          <a class="btn" href="/playlist/show/${show.id}.m3u" download>${raw(icons.vlc)} VLC playlist</a>
        </div>
      </div>
    </div>
    ${seasons.length > 1 ? html`<div class="tabs">${seasons.map((s) => html`<a class="tab ${s === sel ? 'active' : ''}" href="#/show/${show.id}/${s}">${s === 0 ? 'Specials' : `Season ${s}`}</a>`)}</div>` : html`<div style="height:18px"></div>`}
    <div class="episodes">${list.map((e) => episodeRow(e, { current: up && e.id === up.id }))}</div>
  `;
}

function viewTorrents() {
  return html`
    <a class="back-link" href="#/">${raw(icons.arrowLeft)} Library</a>
    <section class="section"><div class="section-head"><h2>Torrents</h2></div>
      <div class="card" id="torrent-add">
        <form class="add-torrent" id="magnet-form">
          <input type="text" id="magnet" placeholder="Paste a magnet link" autocomplete="off" />
          <button class="btn primary" type="submit">${raw(icons.magnet)} Add</button>
          <label class="btn">${raw(icons.upload)} .torrent file<input type="file" id="torrent-file" accept=".torrent,application/x-bittorrent" hidden /></label>
        </form>
        <div class="drop-hint">You can also drop a .torrent file here. Files download into <code>Torrents/</code> in the served folder and can be played while they download.</div>
      </div>
      <div id="torrent-list"><div class="status-chip" style="margin-top:16px"><span class="spinner"></span>Loading…</div></div>
    </section>`;
}

async function refreshTorrents() {
  const host = $('#torrent-list');
  if (!host) return;
  let data;
  try {
    data = await api('/api/torrents');
  } catch (e) {
    host.innerHTML = `<p>${esc(e.message)}</p>`;
    return;
  }
  if (!data.available) {
    $('#torrent-add')?.remove();
    host.innerHTML = html`<div class="card" style="margin-top:14px"><b>Torrent support is unavailable.</b><p style="color:var(--text-2)">${data.error || ''}</p><p style="color:var(--text-3)">Reinstall with <code>npm i -g shoebox-streamer</code> (optional dependencies enabled) to turn it on.</p></div>`.s;
    return;
  }
  if (!data.torrents.length) {
    host.innerHTML = `<p style="color:var(--text-3);margin-top:16px">No torrents yet.</p>`;
    return;
  }
  host.innerHTML = data.torrents
    .map(
      (t) => html`<div class="card torrent">
        <div class="torrent-head">
          <div style="flex:1;min-width:0">
            <div class="name">${t.name}</div>
            <div class="stats">${t.done ? 'Complete' : t.ready ? `${(t.progress * 100).toFixed(1)}% · ↓ ${fmtBytes(t.downloadSpeed)}/s · ${t.peers} peer${t.peers === 1 ? '' : 's'}${t.timeRemaining ? ` · ${fmtTime(t.timeRemaining / 1000)} left` : ''}` : 'Fetching metadata…'} ${t.size ? ` · ${fmtBytes(t.downloaded)} / ${fmtBytes(t.size)}` : ''}</div>
          </div>
          <button class="icon-btn" data-remove="${t.infoHash}" title="Remove">${raw(icons.trash)}</button>
        </div>
        <div class="bar ${t.done ? 'done' : ''}"><i style="width:${(t.progress * 100).toFixed(1)}%"></i></div>
        ${t.files.map(
          (f) => html`<div class="tfile"><span class="fname">${f.name}</span><span class="pct">${fmtBytes(f.size)} · ${Math.round(f.progress * 100)}%</span>
          <a class="btn small primary" href="#/watch/${f.id}">${raw(icons.play)} Play</a></div>`
        )}
        ${t.ready && !t.files.length ? html`<div class="tfile"><span class="fname" style="color:var(--text-3)">No video files in this torrent</span></div>` : ''}
      </div>`.s
    )
    .join('');
}

function bindTorrentPage() {
  const form = $('#magnet-form');
  if (!form) return;
  const add = async (body, headers) => {
    try {
      const t = await api('/api/torrents', { method: 'POST', body, headers });
      toast(t.duplicate ? `Torrent already added, skipping: ${t.name}` : `Added: ${t.name}`);
      refreshTorrents();
    } catch (e) {
      toast(`Could not add torrent: ${e.message}`);
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const m = $('#magnet').value.trim();
    if (!m) return;
    $('#magnet').value = '';
    add(JSON.stringify({ magnet: m }));
  };
  $('#torrent-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) add(await f.arrayBuffer(), { 'content-type': 'application/x-bittorrent' });
  };
  const zone = $('#torrent-add');
  zone.ondragover = (e) => (e.preventDefault(), zone.classList.add('drop-active'));
  zone.ondragleave = () => zone.classList.remove('drop-active');
  zone.ondrop = async (e) => {
    e.preventDefault();
    zone.classList.remove('drop-active');
    const f = e.dataTransfer.files[0];
    if (f) add(await f.arrayBuffer(), { 'content-type': 'application/x-bittorrent' });
    else {
      const text = e.dataTransfer.getData('text');
      if (text?.startsWith('magnet:')) add(JSON.stringify({ magnet: text }));
    }
  };
  $('#torrent-list').onclick = async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const del = confirm('Also delete downloaded files?\n\nOK = remove and delete files, Cancel = remove but keep files');
    await api(`/api/torrents/${b.dataset.remove}${del ? '?delete=1' : ''}`, { method: 'DELETE' });
    refreshTorrents();
  };
  refreshTorrents();
  clearInterval(state.torrentTimer);
  state.torrentTimer = setInterval(() => {
    if (state.route?.name === 'torrents') refreshTorrents();
    else clearInterval(state.torrentTimer);
  }, 2000);
}

// ------------------------------------------------------------------ router
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'show') return { name: 'show', id: parts[1], season: parts[2] != null ? Number(parts[2]) : null };
  if (parts[0] === 'watch') return { name: 'watch', id: parts[1] };
  if (parts[0] === 'torrents') return { name: 'torrents' };
  return { name: 'home' };
}

let lastViewKey = null;
function render({ keepScroll = true } = {}) {
  const r = state.route;
  let view = r;
  if (r.name === 'watch') {
    // Render a sensible page behind the player (e.g. after a refresh on a /watch URL).
    if (lastViewKey) return;
    const it = state.items.get(r.id);
    view = it?.showId ? { name: 'show', id: it.showId } : { name: 'home' };
  }
  const key = JSON.stringify(view);
  const sameView = key === lastViewKey;
  if (!sameView && lastViewKey) state.scroll.set(lastViewKey, scrollY);
  let out;
  if (view.name === 'show') out = viewShow(view.id, view.season);
  else if (view.name === 'torrents') out = viewTorrents();
  else out = viewHome();
  app.innerHTML = `<main>${out.s}</main>`;
  lastViewKey = key;
  if (view.name === 'torrents') bindTorrentPage();
  if (!sameView) scrollTo(0, state.scroll.get(key) || 0);
  else if (!keepScroll) scrollTo(0, 0);
}

app.addEventListener('click', (e) => {
  const m = e.target.closest('[data-menu]');
  if (m) {
    e.preventDefault();
    const it = state.items.get(m.dataset.menu);
    if (it) itemMenu(m, it);
  }
});

function onRoute() {
  const prev = state.route;
  state.route = parseRoute();
  closeMenu();
  if (state.route.name === 'watch') {
    render();
    openPlayerFor(state.route.id);
    return;
  }
  if (state.player) {
    state.player.destroy();
    state.player = null;
    unlockScroll();
  }
  if (prev?.name === 'watch' && lastViewKey) {
    // Returning from the player: re-render to refresh progress, keep scroll.
    render();
    return;
  }
  render();
}

// iPhone Safari ignores overflow:hidden on <body>, so pin the page in place instead and restore the
// scroll position afterwards. A page that can scroll under the player confuses touch handling there.
let lockedScrollY = null;
function lockScroll() {
  if (lockedScrollY !== null) return;
  lockedScrollY = window.scrollY;
  document.body.classList.add('no-scroll');
  document.body.style.top = `-${lockedScrollY}px`;
}
function unlockScroll() {
  if (lockedScrollY === null) return;
  document.body.classList.remove('no-scroll');
  document.body.style.top = '';
  window.scrollTo(0, lockedScrollY);
  lockedScrollY = null;
}

function openPlayerFor(id) {
  const item = state.items.get(id);
  if (!item) {
    toast('That video is no longer in the library');
    location.replace('#/');
    return;
  }
  lockScroll();
  if (state.player) {
    state.player.load(item);
    return;
  }
  state.player = new Player($('#player-root'), {
    getItem: (i) => state.items.get(i),
    getShow: (i) => state.shows.get(i),
    episodesOf: (show) => showEpisodes(show),
    externalLinks,
    episodeRow,
    onClose: () => {
      const it = state.items.get(state.route.id);
      if (history.length > 1 && lastViewKey) history.back();
      else location.hash = it?.showId ? `#/show/${it.showId}` : '#/';
    },
    navigate: (itemId) => location.replace(`#/watch/${itemId}`),
  });
  state.player.load(item);
}

// ------------------------------------------------------------------ watch-time sync (--sync-watchtime)
let pendingProgress = {};
let pushTimer = null;
function pushProgress(entries, now = false) {
  Object.assign(pendingProgress, entries);
  clearTimeout(pushTimer);
  const send = () => {
    const body = JSON.stringify({ entries: pendingProgress });
    pendingProgress = {};
    fetch('/api/progress', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  };
  if (now) send();
  else pushTimer = setTimeout(send, 1000);
}

async function startWatchtimeSync() {
  try {
    const { entries } = await api('/api/progress');
    store.mergeProgress(entries);
  } catch {}
  store.onProgressChange((id, entry) => pushProgress({ [id]: entry }));
  pushProgress(store.allProgress(), true); // share what this device watched before the session
  window.addEventListener('pagehide', () => Object.keys(pendingProgress).length && pushProgress({}, true));
}

// ------------------------------------------------------------------ boot
async function boot() {
  renderTopbar();
  try {
    await loadLibrary();
  } catch (e) {
    app.innerHTML = `<div class="empty"><h2>Can't reach the Shoebox server</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  renderTopbar();
  // Needed before the first route: a shared watch position decides where a deep-linked video resumes.
  try {
    state.info = await api('/api/info');
  } catch {}
  if (state.info?.syncWatchtime) await startWatchtimeSync();
  window.addEventListener('hashchange', onRoute);
  onRoute();

  const es = new EventSource('/api/events');
  if (state.info?.syncWatchtime) {
    es.addEventListener('progress', (ev) => {
      let changed = 0;
      try {
        changed = store.mergeProgress(JSON.parse(ev.data));
      } catch {}
      if (changed && state.route.name !== 'watch' && state.route.name !== 'torrents') render();
      if (changed) state.player?.refreshData?.();
    });
    // After a reconnect (e.g. Shoebox restarted) the server's copy may be empty: share ours again.
    es.addEventListener('open', () => pushProgress(store.allProgress()));
  }
  es.onerror = () => {
    // A dropped stream after a restart may mean the session password changed; check before retrying.
    fetch('/api/auth').then((r) => r.json()).then((a) => a.required && !a.signedIn && location.reload()).catch(() => {});
  };
  let reloadTimer;
  es.addEventListener('library', () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      await loadLibrary();
      renderTopbar();
      if (state.route.name !== 'watch' && state.route.name !== 'torrents') render();
      state.player?.refreshData?.();
    }, 300);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !state.player && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#q')?.focus();
  }
  if (e.key === 'Escape') closeMenu();
});

boot();
