import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decide.js';

const chrome = {
  mse: true, hlsNative: false, mp4: true, webm: true,
  video: { h264: true, hevc: false, vp9: true, av1: true },
  audio: { aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false },
};
const item = (ext, v, a, extra = {}) => ({
  ext,
  probe: {
    format: ext === '.mp4' ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'matroska,webm',
    duration: 100,
    video: { codec: v, bitDepth: 8, pixFmt: 'yuv420p', height: 1080, ...extra },
    audio: [{ n: 0, codec: a, default: true }],
    subtitles: [],
  },
});

test('mp4 h264/aac plays directly', () => {
  assert.equal(decide(item('.mp4', 'h264', 'aac'), chrome).mode, 'direct');
});
test('mkv h264 remuxes when keyframes are indexed', () => {
  assert.equal(decide(item('.mkv', 'h264', 'ac3'), chrome, { canRemux: true }).mode, 'remux');
  assert.equal(decide(item('.mkv', 'h264', 'ac3'), chrome, { canRemux: false }).mode, 'transcode');
});
test('hevc transcodes on a browser without hevc', () => {
  assert.equal(decide(item('.mkv', 'hevc', 'aac'), chrome, { canRemux: true }).mode, 'transcode');
});
test('hevc mp4 plays directly on Safari', () => {
  const safari = { ...chrome, hlsNative: true, video: { ...chrome.video, hevc: true } };
  assert.equal(decide(item('.mp4', 'hevc', 'aac'), safari).mode, 'direct');
});
test('ac3 audio in mp4 is not played directly on Chrome', () => {
  assert.notEqual(decide(item('.mp4', 'h264', 'ac3'), chrome, { canRemux: true }).mode, 'direct');
});
test('10-bit h264 transcodes', () => {
  assert.equal(decide(item('.mp4', 'h264', 'aac', { bitDepth: 10 }), chrome).mode, 'transcode');
});
test('quality cap forces transcode at that height', () => {
  const d = decide(item('.mp4', 'h264', 'aac'), chrome, { quality: 720 });
  assert.equal(d.mode, 'transcode');
  assert.equal(d.height, 720);
});
