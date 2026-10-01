// On-demand HLS: a complete VOD playlist is generated up front, and segments are produced by an
// ffmpeg job that is (re)started wherever the player asks. `-copyts` keeps segment timestamps
// identical no matter where a job started, so segments from different jobs splice cleanly.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FFMPEG, pickEncoder, encoderArgs } from './ffmpeg.js';

const TRANSCODE_SEG = 4; // seconds, fixed grid (forced keyframes)
const COPY_SEG = 6; // seconds, target; real boundaries follow source keyframes
const WAIT_AHEAD = 5; // wait for a running job if the request is at most this many segments ahead of it
const MAX_AHEAD = 25; // pause encoding when this far ahead of the player
const IDLE_KILL_MS = 90_000;
const IDLE_DELETE_MS = 20 * 60_000;
const CAN_PAUSE = process.platform !== 'win32';

/** Parse "c-a0" | "t-720-4000-a1" */
export function parseProfile(s) {
  let m = /^c-a(\d+)$/.exec(s);
  if (m) return { mode: 'remux', audio: +m[1] };
  m = /^t-(\d{3,4})-(\d{3,5})-a(\d+)$/.exec(s);
  if (m) return { mode: 'transcode', height: +m[1], kbps: +m[2], audio: +m[3] };
  return null;
}
export function profileString(d) {
  return d.mode === 'remux' ? `c-a${d.audio}` : `t-${d.height}-${d.kbps}-a${d.audio}`;
}

function buildSegments(duration, keyframes) {
  const segs = [];
  if (keyframes && keyframes.length) {
    let start = 0;
    for (const k of keyframes) {
      if (k - start >= COPY_SEG) {
        segs.push({ start, dur: k - start });
        start = k;
      }
    }
    if (duration - start > 0.05) segs.push({ start, dur: duration - start });
    return segs;
  }
  for (let t = 0; t < duration - 0.05; t += TRANSCODE_SEG) segs.push({ start: t, dur: Math.min(TRANSCODE_SEG, duration - t) });
  return segs;
}

class Session {
  constructor(mgr, item, profile, client, segments) {
    this.mgr = mgr;
    this.item = item;
    this.profile = profile;
    this.p = parseProfile(profile);
    this.segments = segments;
    this.dir = path.join(mgr.tmpRoot, `${item.id}-${profile}-${client}`.replace(/[^\w-]/g, '_'));
    fs.mkdirSync(this.dir, { recursive: true });
    this.completed = new Map(); // segment n → file (each job writes its own files, so none is ever overwritten)
    this.job = null;
    this.lastReq = 0;
    this.lastTouch = Date.now();
    this.jobSeq = 0;
  }

  playlist() {
    const target = Math.ceil(Math.max(...this.segments.map((s) => s.dur), 1));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    this.segments.forEach((s, i) => lines.push(`#EXTINF:${s.dur.toFixed(6)},`, `seg-${i}.ts`));
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  async startJob(n) {
    this.killJob();
    const item = this.item;
    const probe = item.probe;
    const p = this.p;
    const seq = ++this.jobSeq;
    const seg = this.segments[n];
    const listFile = path.join(this.dir, `list-${seq}.csv`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const encoder = p.mode === 'transcode' ? this.mgr.encoderOverride || (await pickEncoder()) : null;

    if (encoder === 'h264_vaapi') args.push('-vaapi_device', '/dev/dri/renderD128');
    // Copy mode: seek slightly past the keyframe so the demuxer lands exactly on it.
    const ss = p.mode === 'remux' ? seg.start + 0.05 : seg.start;
    if (n > 0) args.push('-ss', ss.toFixed(3));
    args.push('-copyts', '-i', item.input);
    args.push('-map', '0:v:0');
    if (probe.audio.length) args.push('-map', `0:a:${Math.min(p.audio, probe.audio.length - 1)}`);
    args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');

    if (p.mode === 'remux') {
      args.push('-c:v', 'copy');
    } else {
      const srcStart = (probe.start || 0) + seg.start;
      let vf = `scale=-2:'min(${p.height},ih)':flags=bicubic,format=yuv420p`;
      if (encoder === 'h264_vaapi') vf += ',format=nv12,hwupload';
      args.push('-vf', vf, ...encoderArgs(encoder, p.kbps));
      args.push('-force_key_frames', `expr:gte(t,${srcStart.toFixed(3)}+n_forced*${TRANSCODE_SEG})`);
      if (encoder === 'libx264') args.push('-sc_threshold', '0');
    }
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');

    const rel = this.segments
      .slice(n + 1)
      .map((s) => (s.start - seg.start).toFixed(3))
      .join(',');
    args.push('-f', 'segment', '-segment_format', 'mpegts', '-segment_start_number', String(n));
    if (rel) args.push('-segment_times', rel);
    else args.push('-segment_time', '100000');
    args.push('-segment_list', listFile, '-segment_list_type', 'csv', '-segment_list_flags', '+live', '-muxdelay', '0');
    args.push(path.join(this.dir, `j${seq}-%d.ts`));

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const job = { proc, start: n, seq, listFile, done: new Set(), exited: false, code: null, err: '', paused: false, encoder };
    proc.stderr.on('data', (d) => (job.err = (job.err + d).slice(-3000)));
    proc.on('close', (code) => {
      job.exited = true;
      job.code = code;
      this.readList(job);
      if (code !== 0 && !job.killed) {
        this.mgr.log(`ffmpeg (${this.profile}) for ${item.rel} exited ${code}: ${job.err.trim().split('\n').slice(-2).join(' | ')}`);
        // A hardware encoder that fails before producing anything → fall back to libx264.
        if (encoder && encoder !== 'libx264' && job.done.size === 0) {
          this.mgr.log(`Falling back to libx264 (was ${encoder})`);
          this.mgr.encoderOverride = 'libx264';
          job.retry = true;
        }
      }
    });
    this.job = job;
    this.mgr.log(`ffmpeg ${p.mode} ${item.rel} from segment ${n}${encoder ? ` [${encoder}]` : ''}`, true);
  }

  readList(job) {
    try {
      const txt = fs.readFileSync(job.listFile, 'utf8');
      for (const line of txt.split('\n')) {
        const m = /^j\d+-(\d+)\.ts,/.exec(line);
        if (m) {
          job.done.add(+m[1]);
          this.completed.set(+m[1], path.join(this.dir, line.split(',')[0]));
        }
      }
    } catch {}
  }

  killJob() {
    const j = this.job;
    if (j && !j.exited) {
      j.killed = true;
      if (j.paused) j.proc.kill('SIGCONT');
      j.proc.kill('SIGKILL');
    }
    this.job = null;
  }

  jobFrontier(job) {
    let f = job.start;
    while (job.done.has(f)) f++;
    return f; // first segment this job hasn't finished
  }

  async getSegment(n) {
    if (n < 0 || n >= this.segments.length) return null;
    this.lastTouch = Date.now();
    this.lastReq = n;
    if (this.job) this.readList(this.job);
    if (this.completed.has(n)) return this.completed.get(n);

    const deadline = Date.now() + 60_000;
    let restarts = 0;
    while (Date.now() < deadline) {
      const job = this.job;
      if (job) this.readList(job);
      if (this.completed.has(n)) return this.completed.get(n);

      const usable = job && !job.exited && n >= job.start && n <= this.jobFrontier(job) + WAIT_AHEAD;
      if (!usable) {
        if (job?.exited && job.code !== 0 && !job.retry && n >= job.start && n <= this.jobFrontier(job)) {
          throw new Error('ffmpeg failed: ' + job.err.trim().split('\n').slice(-1)[0]);
        }
        if (restarts++ > 2) throw new Error('could not produce segment');
        await this.startJob(n);
      } else if (job.paused) {
        job.proc.kill('SIGCONT');
        job.paused = false;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error('timed out waiting for segment');
  }

  /** Called periodically: pause encoding far ahead of the player; kill idle jobs. */
  tick(now) {
    const j = this.job;
    if (!j || j.exited) return;
    if (now - this.lastTouch > IDLE_KILL_MS) {
      this.killJob();
      return;
    }
    if (!CAN_PAUSE) return;
    this.readList(j);
    const ahead = this.jobFrontier(j) - this.lastReq;
    if (!j.paused && ahead > MAX_AHEAD) {
      j.proc.kill('SIGSTOP');
      j.paused = true;
    } else if (j.paused && ahead < MAX_AHEAD / 2) {
      j.proc.kill('SIGCONT');
      j.paused = false;
    }
  }

  destroy() {
    this.killJob();
    fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class HlsManager {
  constructor({ library, log = () => {} }) {
    this.library = library;
    this.log = log;
    this.tmpRoot = path.join(os.tmpdir(), `shoebox-hls-${process.pid}`);
    fs.mkdirSync(this.tmpRoot, { recursive: true });
    this.sessions = new Map();
    this.timer = setInterval(() => this.tick(), 2000);
    this.timer.unref();
  }

  async session(item, profile, client) {
    const key = `${item.id}|${profile}|${client}`;
    let s = this.sessions.get(key);
    if (s && s.item.size !== item.size) {
      s.destroy();
      s = null;
    }
    if (!s) {
      const p = parseProfile(profile);
      if (!p) throw Object.assign(new Error('bad profile'), { status: 400 });
      if (!item.probe) throw Object.assign(new Error('not probed yet'), { status: 409 });
      let kf = null;
      if (p.mode === 'remux') {
        kf = await this.library.getKeyframes(item);
        if (!kf) throw Object.assign(new Error('keyframe index not ready'), { status: 409 });
        const start = item.probe.start || 0;
        kf = kf.map((k) => k - start).filter((k) => k >= 0);
      }
      // A client starting a new session for the same item stops its old ones.
      for (const [k, other] of this.sessions) {
        if (k.startsWith(item.id + '|') && k.endsWith('|' + client)) {
          other.destroy();
          this.sessions.delete(k);
        }
      }
      s = new Session(this, item, profile, client, buildSegments(item.probe.duration, kf));
      this.sessions.set(key, s);
    }
    s.lastTouch = Date.now();
    return s;
  }

  tick() {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      s.tick(now);
      if (now - s.lastTouch > IDLE_DELETE_MS) {
        s.destroy();
        this.sessions.delete(k);
      }
    }
  }

  stopClient(client) {
    for (const [k, s] of this.sessions) {
      if (k.endsWith('|' + client)) s.killJob();
    }
  }

  get activeJobs() {
    return [...this.sessions.values()].filter((s) => s.job && !s.job.exited).length;
  }

  shutdown() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) s.killJob();
    try {
      fs.rmSync(this.tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
