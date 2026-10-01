import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function onPath(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function resolveBinary(name, envVar, pkg) {
  if (process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar];
  const sys = onPath(name);
  if (sys) return sys;
  try {
    const mod = require(pkg);
    const p = typeof mod === 'string' ? mod : mod?.path;
    if (p && existsSync(p)) return p;
  } catch {}
  return null;
}

export const FFMPEG = resolveBinary('ffmpeg', 'SHOEBOX_FFMPEG', 'ffmpeg-static');
export const FFPROBE = resolveBinary('ffprobe', 'SHOEBOX_FFPROBE', 'ffprobe-static');

/** Run a binary, collecting stdout. Rejects on non-zero exit. */
export function run(bin, args, { timeout = 0, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    let timer;
    if (timeout) timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => {
      size += d.length;
      if (size <= maxBuffer) out.push(d);
    });
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** ffprobe a file (or URL) and return a normalized description. */
export async function probe(input) {
  const buf = await run(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
    { timeout: 60000 }
  );
  const j = JSON.parse(buf.toString());
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const lang = (s) => s.tags?.language || s.tags?.LANGUAGE;
  const title = (s) => s.tags?.title || s.tags?.TITLE;
  const bitDepth = v
    ? parseInt(v.bits_per_raw_sample, 10) || (/10le|10be|p010/.test(v.pix_fmt || '') ? 10 : /12le/.test(v.pix_fmt || '') ? 12 : 8)
    : undefined;
  return {
    format: j.format?.format_name || '',
    duration: parseFloat(j.format?.duration) || parseFloat(v?.duration) || 0,
    start: parseFloat(j.format?.start_time) || 0,
    bitrate: parseInt(j.format?.bit_rate, 10) || 0,
    video: v && {
      index: v.index,
      codec: v.codec_name,
      profile: v.profile,
      level: v.level,
      pixFmt: v.pix_fmt,
      bitDepth,
      width: v.width,
      height: v.height,
      fps: (() => {
        const [a, b] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
        return b ? a / b : 0;
      })(),
      hdr: /smpte2084|arib-std-b67/.test(v.color_transfer || ''),
    },
    audio: audio.map((s, i) => ({
      index: s.index,
      n: i,
      codec: s.codec_name,
      profile: s.profile,
      channels: s.channels,
      lang: lang(s),
      title: title(s),
      default: !!s.disposition?.default,
    })),
    subtitles: subs.map((s, i) => ({
      index: s.index,
      n: i,
      codec: s.codec_name,
      lang: lang(s),
      title: title(s),
      forced: !!s.disposition?.forced,
      default: !!s.disposition?.default,
      text: ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'srt'].includes(s.codec_name),
    })),
  };
}

/** Extract one JPEG frame at `at` seconds, scaled to `width`. */
export async function grabFrame(input, at, outFile, width = 480) {
  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(Math.max(0, at)), '-i', input,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4',
      outFile,
    ],
    { timeout: 60000 }
  );
}

/** List of keyframe timestamps (seconds) of the first video stream. Reads packets only, no decoding. */
export async function keyframes(input) {
  const buf = await run(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input],
    { timeout: 10 * 60000, maxBuffer: 512 * 1024 * 1024 }
  );
  const out = [];
  for (const line of buf.toString().split('\n')) {
    const [t, flags] = line.split(',');
    if (flags && flags[0] === 'K') {
      const n = parseFloat(t);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Convert a subtitle stream (or external file) to WebVTT text. */
export async function toWebVTT(input, streamIndex) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', input];
  if (streamIndex != null) args.push('-map', `0:${streamIndex}`);
  args.push('-f', 'webvtt', '-');
  return (await run(FFMPEG, args, { timeout: 5 * 60000 })).toString();
}

// ---------------------------------------------------------------------------
// Hardware encoder detection: try each candidate on a tiny synthetic clip.

const HW_CANDIDATES = {
  darwin: ['h264_videotoolbox'],
  linux: ['h264_nvenc', 'h264_qsv', 'h264_vaapi'],
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
};

let encoderPromise;
export function pickEncoder() {
  if (process.env.SHOEBOX_ENCODER) return Promise.resolve(process.env.SHOEBOX_ENCODER);
  encoderPromise ??= (async () => {
    for (const enc of HW_CANDIDATES[process.platform] || []) {
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-t', '0.5'];
      if (enc === 'h264_vaapi') args.push('-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload');
      args.push('-c:v', enc, '-f', 'null', '-');
      try {
        await run(FFMPEG, args, { timeout: 15000 });
        return enc;
      } catch {}
    }
    return 'libx264';
  })();
  return encoderPromise;
}

/** Encoder-specific arguments for a target bitrate. */
export function encoderArgs(enc, kbps) {
  const rate = ['-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`];
  switch (enc) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level', '4.1', ...rate];
    case 'h264_videotoolbox':
      return ['-c:v', enc, '-profile:v', 'high', '-allow_sw', '1', '-realtime', '1', ...rate];
    case 'h264_nvenc':
      return ['-c:v', enc, '-preset', 'p4', '-profile:v', 'high', ...rate];
    case 'h264_qsv':
      return ['-c:v', enc, '-preset', 'veryfast', '-profile:v', 'high', ...rate];
    case 'h264_vaapi':
      return ['-c:v', enc, ...rate];
    default:
      return ['-c:v', enc, ...rate];
  }
}
