// Opt-in playback log for diagnosing phones without a Mac and Web Inspector. Open Shoebox once with
// ?debug in the address bar and this browser sends player events to the Shoebox terminal until it is
// opened with ?debug=off.

const KEY = 'shoebox:debug';
const q = new URLSearchParams(location.search);
if (q.has('debug')) {
  try {
    if (q.get('debug') === 'off') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '1');
  } catch {}
}

export const debugOn = (() => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

const t0 = performance.now();
let buf = [];
let timer = null;

export function dlog(msg) {
  if (!debugOn) return;
  buf.push(`+${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}`);
  console.debug('[shoebox]', msg);
  if (!timer) timer = setTimeout(flush, 1000);
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!buf.length) return;
  const body = JSON.stringify({ lines: buf });
  buf = [];
  const blob = new Blob([body], { type: 'application/json' });
  if (!navigator.sendBeacon?.('/api/debug', blob)) {
    fetch('/api/debug', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  }
}

if (debugOn) {
  addEventListener('pagehide', flush);
  dlog(`debug log on: ${navigator.userAgent}`);
}
