import { $, $$, html, raw, esc, api, fmtTime, epCode, toast, copyText } from './util.js';
import { icons } from './icons.js';
import { capabilities } from './caps.js';
import * as store from './store.js';

const SPEEDS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];
const QUALITIES = [
  { v: 'auto', label: 'Auto', sub: 'Original when possible' },
  { v: 1080, label: '1080p' },
  { v: 720, label: '720p', sub: 'Good for phones' },
  { v: 480, label: '480p', sub: 'Weak Wi-Fi' },
];
const MODE_LABEL = { direct: 'Direct Play', remux: 'Remux', transcode: 'Transcode' };
const isTouch = matchMedia('(hover: none)').matches;

export class Player {
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
    this.client = store.clientId();
    this.hls = null;
    this.item = null;
    this.session = null; // last /api/play response
    this.quality = store.getSetting('quality') || 'auto';
    this.audio = null;
    this.subKey = null;
    this.drawerSeason = null;
    this.saveTimer = 0;
    this.lastSave = 0;
    this.upnextState = null;
    this.idleTimer = 0;
    this.tapTimer = 0;
    this.lastTap = { t: 0, side: null };
    this.fallbackTried = false;
    this.wakeLock = null;
    this.build();
    this.bind();
  }

  // ---------------------------------------------------------------- DOM
  build() {
    this.root.innerHTML = html`<div class="player paused loading" tabindex="-1">
      <div class="stage">
        <video playsinline webkit-playsinline preload="auto" crossorigin="anonymous"></video>
        <div class="p-loading"><div class="spinner"></div></div>
        <div class="p-msg"></div>
        <div class="chrome">
          <div class="p-top">
            <button class="pbtn" data-act="close" title="Back">${raw(icons.arrowLeft)}</button>
            <div class="p-title"><div class="t1"></div><div class="t2"></div></div>
            <span class="mode-badge" hidden></span>
            <button class="pbtn" data-act="drawer" title="Episodes (E)">${raw(icons.list)}</button>
            <button class="pbtn" data-act="more" title="More">${raw(icons.more)}</button>
          </div>
          <div class="p-center">
            <button class="pbtn skip" data-act="back10" title="Back 10s">${raw(icons.back10)}</button>
            <button class="pbtn big" data-act="toggle" title="Play/Pause (Space)">${raw(icons.play)}</button>
            <button class="pbtn skip" data-act="fwd10" title="Forward 10s">${raw(icons.fwd10)}</button>
          </div>
          <div class="p-bottom">
            <div class="scrub"><div class="track"><div class="buf"></div><div class="played"></div><div class="knob"></div></div><div class="tip"></div></div>
            <div class="p-controls">
              <button class="pbtn" data-act="toggle" data-role="play" title="Play/Pause (Space)">${raw(icons.play)}</button>
              <button class="pbtn" data-act="prev" title="Previous episode (P)">${raw(icons.prev)}</button>
              <button class="pbtn" data-act="next" title="Next episode (N)">${raw(icons.next)}</button>
              <div class="vol">
                <button class="pbtn" data-act="mute" title="Mute (M)">${raw(icons.volume)}</button>
                <input type="range" min="0" max="1" step="0.02" aria-label="Volume" />
              </div>
              <span class="p-time" data-act="timefmt">0:00 / 0:00</span>
              <span class="spacer"></span>
              <button class="pbtn" data-act="speed" title="Playback speed">${raw(icons.speed)}<span class="lbl" hidden></span></button>
              <button class="pbtn" data-act="cc" title="Subtitles (C)">${raw(icons.cc)}</button>
              <button class="pbtn" data-act="settings" title="Quality & audio">${raw(icons.settings)}</button>
              <button class="pbtn" data-act="pip" title="Picture in picture">${raw(icons.pip)}</button>
              <button class="pbtn" data-act="fullscreen" title="Fullscreen (F)">${raw(icons.fullscreen)}</button>
            </div>
          </div>
        </div>
        <div class="upnext" hidden></div>
        <div class="p-pop" hidden></div>
        <div class="p-error" hidden></div>
      </div>
      <aside class="drawer" aria-label="Episodes"></aside>
    </div>`.s;
    this.el = $('.player', this.root);
    this.video = $('video', this.el);
    this.stage = $('.stage', this.el);
    this.scrub = $('.scrub', this.el);
    this.timeEl = $('.p-time', this.el);
    this.pop = $('.p-pop', this.el);
    this.upnext = $('.upnext', this.el);
    this.errorEl = $('.p-error', this.el);
    this.drawer = $('.drawer', this.el);
    this.badge = $('.mode-badge', this.el);
    this.volInput = $('.vol input', this.el);

    const v = this.video;
    v.volume = store.getSetting('volume') ?? 1;
    v.muted = !!store.getSetting('muted');
    this.volInput.value = v.muted ? 0 : v.volume;
    if (!document.pictureInPictureEnabled && !v.webkitSupportsPresentationMode) $('[data-act=pip]', this.el).hidden = true;
    this.updateVolumeIcon();
    this.el.focus();
  }

  bind() {
    const v = this.video;
    const on = (t, ev, fn, opts) => {
      t.addEventListener(ev, fn, opts);
      (this.cleanup ||= []).push(() => t.removeEventListener(ev, fn, opts));
    };

    on(this.el, 'click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) {
        e.stopPropagation();
        this.action(b.dataset.act, b);
      }
    });

    on(v, 'play', () => this.syncPlayState());
    on(v, 'pause', () => {
      this.syncPlayState();
      this.saveProgress(true);
    });
    on(v, 'playing', () => {
      this.el.classList.remove('loading');
      this.syncPlayState();
    });
    on(v, 'waiting', () => this.el.classList.add('loading'));
    on(v, 'seeking', () => this.el.classList.add('loading'));
    on(v, 'seeked', () => v.readyState >= 3 && this.el.classList.remove('loading'));
    on(v, 'canplay', () => this.el.classList.remove('loading'));
    on(v, 'timeupdate', () => this.onTime());
    on(v, 'progress', () => this.renderScrub());
    on(v, 'durationchange', () => this.renderScrub());
    on(v, 'ratechange', () => this.renderSpeedLabel());
    on(v, 'volumechange', () => {
      store.setSetting('volume', v.volume);
      store.setSetting('muted', v.muted);
      this.updateVolumeIcon();
    });
    on(v, 'ended', () => this.onEnded());
    on(v, 'loadedmetadata', () => this.onMetadata());
    on(v, 'error', () => this.onVideoError());

    on(this.volInput, 'input', () => {
      v.volume = +this.volInput.value;
      v.muted = v.volume === 0;
    });

    // Scrubbing
    const pos = (e) => {
      const r = $('.track', this.scrub).getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    on(this.scrub, 'pointerdown', (e) => {
      e.preventDefault();
      this.scrub.setPointerCapture(e.pointerId);
      this.dragging = true;
      this.scrub.classList.add('dragging');
      this.previewScrub(pos(e));
    });
    on(this.scrub, 'pointermove', (e) => {
      const f = pos(e);
      const tip = $('.tip', this.scrub);
      tip.textContent = fmtTime(f * this.duration());
      tip.style.left = `${f * 100}%`;
      if (this.dragging) this.previewScrub(f);
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.scrub.classList.remove('dragging');
      this.seek(pos(e) * this.duration());
    };
    on(this.scrub, 'pointerup', end);
    on(this.scrub, 'pointercancel', () => {
      this.dragging = false;
      this.scrub.classList.remove('dragging');
    });

    // Taps & clicks on the video surface
    on(this.stage, 'pointerup', (e) => {
      if (e.target.closest('.p-top, .p-bottom, .p-pop, .upnext, .p-error, .pbtn')) return;
      if (!this.pop.hidden) return this.closePop();
      const r = this.stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const side = x < 0.35 ? 'left' : x > 0.65 ? 'right' : 'center';
      const now = Date.now();
      if (e.pointerType === 'mouse') {
        if (now - this.lastTap.t < 300) {
          clearTimeout(this.tapTimer);
          this.toggleFullscreen();
          this.lastTap.t = 0;
          return;
        }
        this.lastTap = { t: now, side };
        this.tapTimer = setTimeout(() => this.toggle(), 220);
        return;
      }
      // touch: double-tap sides to skip, single tap toggles controls
      if (now - this.lastTap.t < 320 && side !== 'center' && side === this.lastTap.side) {
        clearTimeout(this.tapTimer);
        this.skip(side === 'left' ? -10 : 10, side);
        this.lastTap = { t: now, side };
        return;
      }
      this.lastTap = { t: now, side };
      clearTimeout(this.tapTimer);
      this.tapTimer = setTimeout(() => {
        if (this.el.classList.contains('idle')) this.wake();
        else if (!v.paused) this.hideChrome();
      }, 260);
    });

    on(this.el, 'pointermove', (e) => e.pointerType === 'mouse' && this.wake());
    on(document, 'keydown', (e) => this.onKey(e));
    on(document, 'fullscreenchange', () => this.syncFullscreen());
    on(document, 'webkitfullscreenchange', () => this.syncFullscreen());
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.requestWakeLock();
      else this.saveProgress(true);
    });
    on(window, 'pagehide', () => this.saveProgress(true));

    on(this.drawer, 'click', (e) => {
      const tab = e.target.closest('[data-season]');
      if (tab) {
        e.preventDefault();
        this.drawerSeason = Number(tab.dataset.season);
        this.renderDrawer();
        return;
      }
      const a = e.target.closest('a[href^="#/watch/"]');
      if (a) {
        e.preventDefault();
        this.deps.navigate(a.getAttribute('href').split('/').pop());
        if (innerWidth < 760) this.toggleDrawer(false);
      }
    });

    this.setupMediaSession();
    this.requestWakeLock();
  }

  // ---------------------------------------------------------------- loading
  async load(item) {
    if (this.item) this.saveProgress(true);
    this.item = item;
    this.fallbackTried = false;
    this.audio = null;
    this.upnextState = null;
    this.upnext.hidden = true;
    this.errorEl.hidden = true;
    this.closePop();
    this.renderTitle();
    this.renderNavButtons();
    if (this.drawerOpen) this.renderDrawer(true);
    const p = store.getProgress(item.id);
    const startAt = store.inProgress(item.id) ? p.t : 0;
    await this.start({ startAt, autoplay: true });
    if (startAt > 0) {
      toast(`Resumed at ${fmtTime(startAt)}`, { action: 'Start over', onAction: () => this.seek(0) });
    }
    this.wake();
  }

  async start({ startAt = 0, autoplay = true, force = null } = {}) {
    const item = this.item;
    this.el.classList.add('loading');
    let res;
    try {
      res = await api(`/api/play/${item.id}`, {
        method: 'POST',
        body: JSON.stringify({
          caps: capabilities(),
          client: this.client,
          quality: this.quality === 'auto' ? undefined : this.quality,
          audio: this.audio ?? undefined,
          force,
        }),
      });
    } catch (e) {
      return this.showError(e.message);
    }
    if (this.item !== item) return; // switched while waiting
    this.session = res;
    if (this.audio == null) this.audio = res.audio;
    this.renderBadge();
    this.teardownSource();
    this.attachSubtitles();
    const v = this.video;
    v.playbackRate = store.getSetting('speed') || 1;
    this.pendingStart = startAt;

    // iPhone has only ManagedMediaSource; its native HLS player is the more reliable choice there.
    const useHlsJs = res.mode !== 'direct' && window.Hls && Hls.isSupported() && (!!window.MediaSource || !capabilities().hlsNative);
    if (res.mode === 'direct' || !useHlsJs) {
      v.src = res.url;
    } else {
      const hls = new Hls({
        startPosition: startAt || -1,
        maxBufferLength: 40,
        maxMaxBufferLength: 120,
        backBufferLength: 90,
        manifestLoadingTimeOut: 30000,
        fragLoadingTimeOut: 90000,
        fragLoadingMaxRetry: 6,
        enableWorker: true,
      });
      this.hls = hls;
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries++ < 4) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 4) hls.recoverMediaError();
        else this.showError(`Playback failed (${data.details})`);
      });
      hls.loadSource(res.url);
      hls.attachMedia(v);
      this.pendingStart = 0; // hls.js handles startPosition itself
    }
    this.renderScrub();
    if (autoplay) {
      try {
        await v.play();
      } catch {
        this.el.classList.remove('loading');
        this.syncPlayState();
      }
    }
    this.updateMediaSession();
  }

  teardownSource() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
    $$('track', this.video).forEach((t) => t.remove());
    this.video.load();
  }

  onMetadata() {
    const v = this.video;
    if (this.pendingStart) {
      v.currentTime = this.pendingStart;
      this.pendingStart = 0;
    }
    this.renderScrub();
    // Direct play that decodes no video (e.g. unsupported codec reported as playable) → transcode.
    if (this.session?.mode === 'direct' && this.item.vcodec && v.videoWidth === 0) {
      setTimeout(() => {
        if (v.videoWidth === 0 && this.session?.mode === 'direct') this.fallback('no video decoded');
      }, 1500);
    }
    // Same for audio, where the browser exposes decoded byte counts.
    if (this.session?.mode === 'direct' && this.item.acodec && 'webkitAudioDecodedByteCount' in v) {
      setTimeout(() => {
        if (this.session?.mode === 'direct' && !v.paused && v.currentTime > 1 && v.webkitAudioDecodedByteCount === 0) this.fallback('no audio decoded');
      }, 4000);
    }
  }

  onVideoError() {
    if (!this.video.getAttribute('src') && !this.hls) return;
    const err = this.video.error;
    if (this.session?.mode === 'direct') return this.fallback(err?.message || 'decode error');
    if (!this.hls) this.showError(`Playback error${err?.message ? `: ${err.message}` : ''}`);
  }

  fallback(why) {
    if (this.fallbackTried) return this.showError(`This device can't play the file (${why}).`);
    this.fallbackTried = true;
    console.info('[shoebox] direct play failed, switching to server conversion:', why);
    this.flash('Converting for this device…');
    this.start({ startAt: this.video.currentTime || this.pendingStart || 0, force: 'transcode' });
  }

  showError(msg) {
    this.el.classList.remove('loading');
    const ext = this.deps.externalLinks(this.item);
    this.errorEl.hidden = false;
    this.errorEl.innerHTML = html`<div><h3 style="margin:0 0 6px">Can't play this video</h3><div style="opacity:.8;max-width:460px">${msg}</div>
      <div class="actions" style="justify-content:center">
        <button class="btn primary" data-act="retry-transcode">Try converting</button>
        <a class="btn" href="${ext.vlc}">${raw(icons.vlc)} Open in VLC</a>
      </div></div>`.s;
  }

  // ---------------------------------------------------------------- actions
  action(act, btn) {
    const v = this.video;
    switch (act) {
      case 'close':
        return this.deps.onClose();
      case 'toggle':
        return this.toggle();
      case 'back10':
        return this.skip(-10);
      case 'fwd10':
        return this.skip(10);
      case 'next':
        return this.goNext();
      case 'prev':
        return this.goPrev();
      case 'mute':
        v.muted = !v.muted;
        if (!v.muted && v.volume === 0) v.volume = 0.5;
        this.volInput.value = v.muted ? 0 : v.volume;
        return;
      case 'fullscreen':
        return this.toggleFullscreen();
      case 'pip':
        return this.togglePip();
      case 'drawer':
        return this.toggleDrawer();
      case 'speed':
        return this.openSpeedMenu(btn);
      case 'cc':
        return this.openSubsMenu(btn);
      case 'settings':
        return this.openSettingsMenu(btn);
      case 'more':
        return this.openMoreMenu(btn);
      case 'timefmt':
        this.showRemaining = !this.showRemaining;
        return this.onTime();
      case 'retry-transcode':
        this.errorEl.hidden = true;
        this.fallbackTried = true;
        return this.start({ startAt: v.currentTime || 0, force: 'transcode' });
      case 'upnext-play':
        return this.goNext();
      case 'upnext-cancel':
        this.upnextState = { dismissed: true };
        this.upnext.hidden = true;
        return;
    }
  }

  toggle() {
    const v = this.video;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  }

  seek(t) {
    const v = this.video;
    t = Math.max(0, Math.min(t, this.duration() - 0.5));
    if (v.readyState === 0) this.pendingStart = t;
    else v.currentTime = t;
    this.renderScrub(t);
    this.wake();
  }

  skip(sec, side) {
    this.seek((this.video.currentTime || 0) + sec);
    if (side) {
      const r = document.createElement('div');
      r.className = `tap-ripple ${side}`;
      r.textContent = `${sec > 0 ? '+' : ''}${sec}s`;
      this.stage.appendChild(r);
      setTimeout(() => r.remove(), 650);
    } else this.flash(`${sec > 0 ? '+' : ''}${sec}s`);
  }

  flash(text) {
    const m = $('.p-msg', this.el);
    m.textContent = text;
    m.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => m.classList.remove('show'), 900);
  }

  duration() {
    const d = this.video.duration;
    return this.session?.duration || this.item?.duration || (isFinite(d) ? d : 0);
  }

  // ---------------------------------------------------------------- episodes
  siblings() {
    const it = this.item;
    if (!it?.showId) return null;
    const show = this.deps.getShow(it.showId);
    if (!show) return null;
    const eps = this.deps.episodesOf(show);
    const i = eps.findIndex((e) => e.id === it.id);
    return { show, eps, i, prev: eps[i - 1], next: eps[i + 1] };
  }

  goNext() {
    const s = this.siblings();
    if (s?.next) this.deps.navigate(s.next.id);
  }
  goPrev() {
    const s = this.siblings();
    if (this.video.currentTime > 15 || !s?.prev) return this.seek(0);
    this.deps.navigate(s.prev.id);
  }

  onEnded() {
    store.setProgress(this.item.id, this.duration(), this.duration());
    store.markWatched(this.item.id, true, this.duration());
    const s = this.siblings();
    if (s?.next && store.getSetting('autoplayNext') && !this.upnextState?.dismissed) this.showUpNext(s.next, true);
    else this.syncPlayState();
  }

  showUpNext(next, countdown) {
    const cur = this.upnextState;
    if (cur?.dismissed) return;
    if (cur?.countdown && countdown) return;
    this.upnextState = { id: next.id, countdown };
    this.upnext.hidden = false;
    this.upnext.innerHTML = html`
      <div class="thumb">${next.thumb ? html`<img src="/thumb/${next.id}.jpg" alt="" />` : ''}</div>
      ${countdown ? html`<div class="ring"></div>` : ''}
      <div class="un-body">
        <div class="un-label">${countdown ? raw('Next episode in <b class="cd">8</b>s') : 'Up next'}</div>
        <div class="un-title">${epCode(next)} · ${next.title || `Episode ${next.episode}`}</div>
        <div class="un-actions">
          <button class="btn primary" data-act="upnext-play">${raw(icons.play)} Play now</button>
          <button class="btn" data-act="upnext-cancel">Cancel</button>
        </div>
      </div>`.s;
    if (countdown) {
      const ring = $('.ring', this.upnext);
      ring.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 8000, easing: 'linear', fill: 'forwards' });
      let n = 8;
      clearInterval(this.cdTimer);
      this.cdTimer = setInterval(() => {
        n--;
        const cd = $('.cd', this.upnext);
        if (cd) cd.textContent = n;
        if (this.upnextState?.id !== next.id || this.upnext.hidden) return clearInterval(this.cdTimer);
        if (n <= 0) {
          clearInterval(this.cdTimer);
          this.goNext();
        }
      }, 1000);
    }
  }

  toggleDrawer(force) {
    this.drawerOpen = force ?? !this.drawerOpen;
    this.el.classList.toggle('drawer-open', this.drawerOpen);
    if (this.drawerOpen) this.renderDrawer(true);
    this.wake();
  }

  renderDrawer(resetSeason = false) {
    const s = this.siblings();
    if (!s) {
      this.drawer.innerHTML = html`<div class="drawer-head"><h3>${this.item.title}</h3><button class="pbtn" data-act="drawer">${raw(icons.close)}</button></div>
        <p style="padding:0 16px;opacity:.7">This is a movie, so it has no episodes.</p>`.s;
      return;
    }
    const seasons = s.show.seasons;
    if (resetSeason || this.drawerSeason == null) this.drawerSeason = this.item.season ?? seasons[0];
    const list = s.eps.filter((e) => (e.season ?? 1) === this.drawerSeason);
    this.drawer.innerHTML = html`<div class="drawer-head"><h3>${s.show.name}</h3><button class="pbtn" data-act="drawer" title="Close">${raw(icons.close)}</button></div>
      ${seasons.length > 1 ? html`<div class="tabs">${seasons.map((n) => html`<button class="tab ${n === this.drawerSeason ? 'active' : ''}" data-season="${n}">${n === 0 ? 'Specials' : `Season ${n}`}</button>`)}</div>` : ''}
      <div class="drawer-list"><div class="episodes">${list.map((e) => this.deps.episodeRow(e, { current: e.id === this.item.id, compact: true }))}</div></div>`.s;
    const cur = $('.episode.current', this.drawer);
    cur?.scrollIntoView({ block: 'center' });
  }

  refreshData() {
    const fresh = this.deps.getItem(this.item?.id);
    if (fresh) this.item = fresh;
    if (this.drawerOpen) this.renderDrawer();
  }

  // ---------------------------------------------------------------- menus
  openPop(btn, content) {
    if (!this.pop.hidden && this.pop.dataset.for === btn.dataset.act) return this.closePop();
    this.pop.innerHTML = content;
    this.pop.dataset.for = btn.dataset.act;
    this.pop.hidden = false;
    this.pop.onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) {
        e.stopPropagation();
        this.popHandler?.(b.dataset.v, b);
      }
    };
    this.wake();
  }
  closePop() {
    this.pop.hidden = true;
    this.popHandler = null;
  }
  opt(v, label, active, sub) {
    return html`<button data-v="${v}"><span class="ck">${active ? raw(icons.check) : ''}</span>${label}${sub ? html`<span class="sub">${sub}</span>` : ''}</button>`.s;
  }

  openSpeedMenu(btn) {
    const cur = this.video.playbackRate;
    this.openPop(btn, `<h4>Playback speed</h4>` + SPEEDS.map((s) => this.opt(s, s === 1 ? 'Normal' : `${s}×`, Math.abs(cur - s) < 0.01)).join(''));
    this.popHandler = (v) => {
      this.video.playbackRate = +v;
      store.setSetting('speed', +v);
      this.closePop();
    };
  }

  openSubsMenu(btn) {
    const subs = this.item.subtitles || [];
    let out = `<h4>Subtitles</h4>` + this.opt('off', 'Off', !this.subKey);
    out += subs.map((s) => this.opt(s.key, s.label, this.subKey === s.key, s.lang && s.lang !== s.label ? s.lang : s.key[0] === 'e' ? 'file' : '')).join('');
    if (!subs.length) out += `<div style="padding:6px 10px;opacity:.6;font-size:13px">No text subtitles found. Put a matching .srt next to the video to add one.</div>`;
    this.openPop(btn, out);
    this.popHandler = (v) => {
      this.setSubtitle(v === 'off' ? null : v);
      this.closePop();
    };
  }

  openSettingsMenu(btn) {
    const audio = this.item.audio || [];
    let out = `<h4>Quality</h4>` + QUALITIES.map((q) => this.opt(`q:${q.v}`, q.label, String(this.quality) === String(q.v), q.sub)).join('');
    if (audio.length > 1) {
      out += `<h4>Audio</h4>` + audio.map((a) => this.opt(`a:${a.n}`, a.title || a.lang || `Track ${a.n + 1}`, this.audio === a.n, [a.codec?.toUpperCase(), a.channels > 2 ? `${a.channels}ch` : ''].filter(Boolean).join(' '))).join('');
    }
    out += `<h4>Playback</h4>` + this.opt('autoplay', 'Autoplay next episode', store.getSetting('autoplayNext'));
    this.openPop(btn, out);
    this.popHandler = (v) => {
      this.closePop();
      if (v === 'autoplay') {
        store.setSetting('autoplayNext', !store.getSetting('autoplayNext'));
        return this.flash(`Autoplay ${store.getSetting('autoplayNext') ? 'on' : 'off'}`);
      }
      const [k, val] = v.split(':');
      if (k === 'q') {
        this.quality = val === 'auto' ? 'auto' : +val;
        store.setSetting('quality', this.quality);
      } else this.audio = +val;
      const wasPaused = this.video.paused;
      this.start({ startAt: this.video.currentTime || 0, autoplay: !wasPaused });
    };
  }

  openMoreMenu(btn) {
    const ext = this.deps.externalLinks(this.item);
    const s = this.siblings();
    let out = `<h4>Watch elsewhere</h4>`;
    out += html`<button data-v="vlc"><span class="ck">${raw(icons.vlc)}</span>Open in VLC</button>`.s;
    if (s) out += html`<button data-v="m3u"><span class="ck">${raw(icons.list)}</span>VLC playlist from this episode</button>`.s;
    out += html`<button data-v="copy"><span class="ck">${raw(icons.link)}</span>Copy stream URL</button>`.s;
    out += `<h4>Info</h4><div style="padding:4px 10px 8px;font-size:13px;opacity:.8;line-height:1.6">${esc(this.session?.reason || '')}<br>${esc(
      [this.item.vcodec?.toUpperCase(), this.item.height && `${this.item.width}×${this.item.height}`, this.item.acodec?.toUpperCase()].filter(Boolean).join(' · ')
    )}<br><span style="word-break:break-all">${esc(this.item.rel)}</span></div>`;
    this.openPop(btn, out);
    this.popHandler = async (v) => {
      this.closePop();
      if (v === 'vlc') location.href = ext.vlc;
      if (v === 'm3u') location.href = `/playlist/show/${this.item.showId}.m3u?from=${this.item.id}`;
      if (v === 'copy') toast((await copyText(ext.url)) ? 'Stream URL copied, so you can open it in VLC → Open Network Stream' : ext.url, { timeout: 6000 });
    };
  }

  // ---------------------------------------------------------------- subtitles
  attachSubtitles() {
    const subs = this.item.subtitles || [];
    for (const s of subs) {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = s.label;
      if (s.lang) t.srclang = s.lang.slice(0, 3);
      t.src = `/api/subs/${this.item.id}/${s.key}.vtt`;
      t.dataset.key = s.key;
      this.video.appendChild(t);
    }
    // Restore the user's preferred language (or a forced/default track) without the browser auto-picking.
    const pref = store.getSetting('subtitleLang');
    const keep = this.subKey && subs.find((s) => s.key === this.subKey);
    const choice = keep || (pref ? subs.find((s) => s.lang === pref) : null) || subs.find((s) => s.forced);
    setTimeout(() => this.setSubtitle(choice?.key || null, false), 0);
  }

  setSubtitle(key, remember = true) {
    this.subKey = key;
    const tracks = $$('track', this.video);
    tracks.forEach((t) => {
      t.track.mode = t.dataset.key === key ? 'showing' : 'disabled';
    });
    if (remember) {
      const s = (this.item.subtitles || []).find((x) => x.key === key);
      store.setSetting('subtitleLang', s?.lang || null);
    }
    $('[data-act=cc]', this.el).style.color = key ? 'var(--accent)' : '';
  }

  // ---------------------------------------------------------------- rendering
  renderTitle() {
    const it = this.item;
    const show = it.showId && this.deps.getShow(it.showId);
    $('.t1', this.el).textContent = show ? show.name : it.title;
    $('.t2', this.el).textContent = show ? `${epCode(it)}${it.title ? ' · ' + it.title : ''}` : [it.year].filter(Boolean).join(' · ');
    document.title = `${show ? `${show.name} ${epCode(it)}` : it.title} · Shoebox`;
  }

  renderNavButtons() {
    const s = this.siblings();
    $('[data-act=prev]', this.el).hidden = !s;
    $('[data-act=next]', this.el).hidden = !s;
    $('[data-act=next]', this.el).disabled = !s?.next;
    $('.p-top [data-act=drawer]', this.el).hidden = !s;
  }

  renderBadge() {
    const r = this.session;
    this.badge.hidden = !r;
    if (!r) return;
    this.badge.className = `mode-badge ${r.mode}`;
    this.badge.textContent = MODE_LABEL[r.mode] + (r.height ? ` ${r.height}p` : '');
    this.badge.title = r.reason;
  }

  renderSpeedLabel() {
    const lbl = $('[data-act=speed] .lbl', this.el);
    const r = this.video.playbackRate;
    lbl.hidden = r === 1;
    lbl.textContent = `${r}×`;
  }

  syncPlayState() {
    const paused = this.video.paused;
    this.el.classList.toggle('paused', paused);
    $$('[data-act=toggle]', this.el).forEach((b) => (b.innerHTML = paused ? icons.play : icons.pause));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    if (paused) this.wake(true);
    else this.wake();
  }

  updateVolumeIcon() {
    const v = this.video;
    $('[data-act=mute]', this.el).innerHTML = v.muted || v.volume === 0 ? icons.mute : v.volume < 0.5 ? icons.volumeLow : icons.volume;
  }

  previewScrub(f) {
    this.renderScrub(f * this.duration());
  }

  renderScrub(at) {
    const d = this.duration();
    const v = this.video;
    const t = at ?? v.currentTime ?? 0;
    if (!this.dragging || at != null) {
      const pct = d ? (t / d) * 100 : 0;
      $('.played', this.scrub).style.width = `${pct}%`;
      $('.knob', this.scrub).style.left = `${pct}%`;
    }
    let bufEnd = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 1 && v.buffered.end(i) >= t) bufEnd = v.buffered.end(i);
    }
    $('.buf', this.scrub).style.width = d ? `${(Math.max(bufEnd, t) / d) * 100}%` : '0';
    this.timeEl.textContent = this.showRemaining ? `-${fmtTime(d - t)} / ${fmtTime(d)}` : `${fmtTime(t)} / ${fmtTime(d)}`;
  }

  onTime() {
    if (!this.dragging) this.renderScrub();
    this.saveProgress();
    const s = this.siblings();
    const d = this.duration();
    const left = d - this.video.currentTime;
    if (s?.next && d > 120 && left < 25 && left > 1 && !this.upnextState) this.showUpNext(s.next, false);
    if (this.upnextState && !this.upnextState.countdown && !this.upnextState.dismissed && left > 30) {
      this.upnextState = null;
      this.upnext.hidden = true;
    }
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d && Date.now() - (this.lastPos || 0) > 5000) {
      this.lastPos = Date.now();
      try {
        navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, this.video.currentTime), playbackRate: this.video.playbackRate });
      } catch {}
    }
  }

  saveProgress(force = false) {
    if (!this.item) return;
    const now = Date.now();
    if (!force && now - this.lastSave < 5000) return;
    const t = this.video.currentTime;
    if (!t || t < 1) return;
    this.lastSave = now;
    store.setProgress(this.item.id, t, this.duration());
  }

  // ---------------------------------------------------------------- chrome visibility
  wake(stay = false) {
    this.el.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (stay) return;
    this.idleTimer = setTimeout(() => this.hideChrome(), isTouch ? 3500 : 2600);
  }
  hideChrome() {
    if (this.video.paused || !this.pop.hidden || this.dragging || (this.drawerOpen && innerWidth < 760)) return;
    this.el.classList.add('idle');
  }

  // ---------------------------------------------------------------- fullscreen / pip
  async toggleFullscreen() {
    const doc = document;
    const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (fsEl) return (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    const el = this.el;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        await req.call(el, { navigationUI: 'hide' });
        screen.orientation?.lock?.('landscape').catch(() => {});
        return;
      } catch {}
    }
    // iPhone: only the native video player can go fullscreen.
    if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
  }
  syncFullscreen() {
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $('[data-act=fullscreen]', this.el).innerHTML = fs ? icons.exitFullscreen : icons.fullscreen;
  }
  async togglePip() {
    const v = this.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch (e) {
      toast(`Picture-in-picture unavailable: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- keyboard
  onKey(e) {
    if (e.target.closest?.('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = this.video;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      this.wake();
    };
    switch (k) {
      case ' ':
      case 'k':
        handled();
        return this.toggle();
      case 'ArrowLeft':
      case 'j':
        handled();
        return this.skip(k === 'j' ? -10 : -5);
      case 'ArrowRight':
      case 'l':
        handled();
        return this.skip(k === 'l' ? 10 : 5);
      case 'ArrowUp':
        handled();
        v.volume = Math.min(1, v.volume + 0.05);
        v.muted = false;
        this.volInput.value = v.volume;
        return this.flash(`Volume ${Math.round(v.volume * 100)}%`);
      case 'ArrowDown':
        handled();
        v.volume = Math.max(0, v.volume - 0.05);
        this.volInput.value = v.volume;
        return this.flash(`Volume ${Math.round(v.volume * 100)}%`);
      case 'f':
        handled();
        return this.toggleFullscreen();
      case 'm':
        handled();
        return this.action('mute');
      case 'n':
      case 'N':
        handled();
        return this.goNext();
      case 'p':
      case 'P':
        handled();
        return this.goPrev();
      case 'e':
        handled();
        return this.toggleDrawer();
      case 'c': {
        handled();
        const subs = this.item.subtitles || [];
        if (!subs.length) return this.flash('No subtitles');
        const i = subs.findIndex((s) => s.key === this.subKey);
        const next = subs[i + 1];
        this.setSubtitle(next ? next.key : null);
        return this.flash(next ? `Subtitles: ${next.label}` : 'Subtitles off');
      }
      case '>':
      case '<': {
        handled();
        const i = SPEEDS.findIndex((s) => Math.abs(s - v.playbackRate) < 0.01);
        const n = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + (k === '>' ? 1 : -1)))];
        v.playbackRate = n;
        store.setSetting('speed', n);
        return this.flash(`${n}×`);
      }
      case 'Escape':
        if (!this.pop.hidden) return this.closePop();
        if (this.drawerOpen) return this.toggleDrawer(false);
        if (document.fullscreenElement || document.webkitFullscreenElement) return;
        return this.deps.onClose();
      default:
        if (/^[0-9]$/.test(k)) {
          handled();
          this.seek((+k / 10) * this.duration());
        }
    }
  }

  // ---------------------------------------------------------------- platform integrations
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, fn) => {
      try {
        ms.setActionHandler(a, fn);
      } catch {}
    };
    set('play', () => this.video.play());
    set('pause', () => this.video.pause());
    set('seekbackward', (d) => this.skip(-(d.seekOffset || 10)));
    set('seekforward', (d) => this.skip(d.seekOffset || 10));
    set('seekto', (d) => this.seek(d.seekTime));
    set('previoustrack', () => this.goPrev());
    set('nexttrack', () => this.goNext());
  }
  updateMediaSession() {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const it = this.item;
    const show = it.showId && this.deps.getShow(it.showId);
    const art = show?.poster || it.poster || (it.thumb ? `/thumb/${it.id}.jpg` : null);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: show ? `${epCode(it)} ${it.title || ''}`.trim() : it.title,
      artist: show ? show.name : 'Shoebox',
      artwork: art ? [{ src: new URL(art, location.href).href, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  }
  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
      }
    } catch {}
  }

  destroy() {
    this.saveProgress(true);
    clearTimeout(this.idleTimer);
    clearInterval(this.cdTimer);
    for (const fn of this.cleanup || []) fn();
    this.teardownSource();
    if (this.session && this.session.mode !== 'direct') {
      navigator.sendBeacon?.('/api/stop', new Blob([JSON.stringify({ client: this.client })], { type: 'application/json' }));
    }
    this.wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    document.title = 'Shoebox';
    this.root.innerHTML = '';
  }
}
