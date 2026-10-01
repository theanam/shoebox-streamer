// Probe what this device can decode natively. Sent to the server with every play request.

const video = document.createElement('video');
const MSE = window.ManagedMediaSource || window.MediaSource;

function supported(mime) {
  try {
    if (MSE && MSE.isTypeSupported(mime)) return true;
  } catch {}
  return video.canPlayType(mime) === 'probably';
}

let cached;
export function capabilities() {
  if (cached) return cached;
  cached = {
    mse: !!MSE,
    hlsNative: video.canPlayType('application/vnd.apple.mpegurl') !== '',
    mp4: video.canPlayType('video/mp4') !== '',
    webm: video.canPlayType('video/webm') !== '',
    video: {
      h264: supported('video/mp4; codecs="avc1.640028"') || supported('video/mp4; codecs="avc1.42E01E"'),
      h264high10: supported('video/mp4; codecs="avc1.6E0028"'),
      hevc: supported('video/mp4; codecs="hvc1.1.6.L120.90"') || supported('video/mp4; codecs="hev1.1.6.L120.90"'),
      hevc10: supported('video/mp4; codecs="hvc1.2.4.L120.90"'),
      vp8: supported('video/webm; codecs="vp8"'),
      vp9: supported('video/webm; codecs="vp09.00.10.08"') || supported('video/webm; codecs="vp9"'),
      av1: supported('video/mp4; codecs="av01.0.08M.08"'),
    },
    audio: {
      aac: supported('audio/mp4; codecs="mp4a.40.2"'),
      mp3: supported('audio/mpeg') || supported('audio/mp4; codecs="mp4a.6B"') || video.canPlayType('audio/mpeg') !== '',
      opus: supported('audio/webm; codecs="opus"') || supported('audio/mp4; codecs="opus"'),
      vorbis: supported('audio/webm; codecs="vorbis"'),
      flac: supported('audio/mp4; codecs="flac"') || supported('audio/flac'),
      ac3: supported('audio/mp4; codecs="ac-3"'),
      eac3: supported('audio/mp4; codecs="ec-3"'),
    },
  };
  return cached;
}
