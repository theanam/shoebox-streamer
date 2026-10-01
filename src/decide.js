// Decide how a given client should play a given file.
//
// caps (reported by the browser):
//   { mp4, webm, hlsNative, mse, video: { h264, h264high10, hevc, hevc10, vp8, vp9, av1 },
//     audio: { aac, mp3, opus, vorbis, flac, ac3, eac3 } }

const QUALITY = {
  1080: { height: 1080, kbps: 8000 },
  720: { height: 720, kbps: 4000 },
  480: { height: 480, kbps: 1800 },
};

function videoSupported(v, caps) {
  const c = caps.video || {};
  if (!v) return { ok: true };
  const pix = v.pixFmt || '';
  if (/444|422/.test(pix)) return { ok: false, why: `${v.codec} ${pix} chroma` };
  switch (v.codec) {
    case 'h264':
      if (v.bitDepth > 8) return c.h264high10 ? { ok: true } : { ok: false, why: 'H.264 10-bit' };
      return c.h264 ? { ok: true } : { ok: false, why: 'H.264' };
    case 'hevc':
      if (v.bitDepth > 8) return c.hevc10 ? { ok: true } : { ok: false, why: 'HEVC 10-bit' };
      return c.hevc ? { ok: true } : { ok: false, why: 'HEVC' };
    case 'vp9':
      return c.vp9 ? { ok: true } : { ok: false, why: 'VP9' };
    case 'vp8':
      return c.vp8 ? { ok: true } : { ok: false, why: 'VP8' };
    case 'av1':
      return c.av1 ? { ok: true } : { ok: false, why: 'AV1' };
    default:
      return { ok: false, why: String(v.codec || 'unknown').toUpperCase() };
  }
}

function audioSupported(a, caps) {
  if (!a) return { ok: true };
  const c = caps.audio || {};
  const key = { aac: 'aac', mp3: 'mp3', opus: 'opus', vorbis: 'vorbis', flac: 'flac', ac3: 'ac3', eac3: 'eac3' }[a.codec];
  if (key && c[key]) return { ok: true };
  return { ok: false, why: `${String(a.codec).toUpperCase()} audio` };
}

function containerKind(ext, format) {
  ext = ext.toLowerCase();
  if (['.mp4', '.m4v', '.mov'].includes(ext) && /mp4|mov/.test(format)) return 'mp4';
  if (ext === '.webm' && /webm|matroska/.test(format)) return 'webm';
  return null;
}

/**
 * @param {object} item     library item: { ext, probe }
 * @param {object} caps     client capabilities
 * @param {object} opts     { quality?: 'auto'|1080|720|480, audio?: number (audio track n), canRemux: bool }
 * @returns {{ mode:'direct'|'remux'|'transcode', reason:string, height?:number, kbps?:number, audio:number }}
 */
export function decide(item, caps, opts = {}) {
  const p = item.probe;
  if (!p) return { mode: 'transcode', reason: 'File not probed yet', audio: 0, ...QUALITY[720] };
  const audioN = Number.isInteger(opts.audio) && p.audio[opts.audio] ? opts.audio : Math.max(0, p.audio.findIndex((a) => a.default));
  const a = p.audio[audioN];
  const v = p.video;

  const q = QUALITY[opts.quality];
  if (q && v && v.height > q.height + 8) {
    return { mode: 'transcode', reason: `Quality limited to ${q.height}p`, audio: audioN, ...q };
  }

  const vs = videoSupported(v, caps);
  const as = audioSupported(a, caps);
  const kind = containerKind(item.ext, p.format);
  const containerOk = kind === 'mp4' ? caps.mp4 : kind === 'webm' ? caps.webm : false;
  // Browsers only play the first/default audio track of a file natively.
  const nativeAudioOk = audioN === Math.max(0, p.audio.findIndex((a) => a.default)) || p.audio.length <= 1;

  if (vs.ok && as.ok && containerOk && nativeAudioOk) {
    return { mode: 'direct', reason: 'Device supports this format', audio: audioN };
  }

  const hlsOk = caps.mse || caps.hlsNative;
  if (!hlsOk) return { mode: 'direct', reason: 'Device has no HLS support; trying the original file', audio: audioN };

  const why = [];
  if (!containerOk) why.push(`${item.ext.slice(1).toUpperCase()} container`);
  if (!as.ok) why.push(as.why);
  if (!nativeAudioOk) why.push('alternate audio track');

  // TS segments carry H.264 fine; copy the video stream and only fix the container/audio.
  if (vs.ok && v?.codec === 'h264' && v.bitDepth <= 8 && opts.canRemux) {
    return { mode: 'remux', reason: `Remuxing: ${why.join(', ') || 'container'}`, audio: audioN };
  }

  if (!vs.ok) why.unshift(`${vs.why} video`);
  const src = v?.height || 1080;
  const target = src > 1080 ? QUALITY[1080] : { height: src, kbps: src >= 1000 ? 8000 : src >= 700 ? 4500 : 2000 };
  return { mode: 'transcode', reason: `Transcoding: ${why.join(', ') || 'unsupported format'}`, audio: audioN, ...target };
}
