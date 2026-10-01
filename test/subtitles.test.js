import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openSubtitlesHash, decodeText, unzip, rank, pickArchiveEntry } from '../src/subtitles.js';
import { toIso1, parseSubtitleTags } from '../src/lang.js';
import { srtToVtt } from '../src/server.js';
import { Library } from '../src/library.js';
import { parsePath } from '../src/parse.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-subs-'));

test('language normalization', () => {
  for (const [input, want] of [['eng', 'en'], ['en', 'en'], ['English', 'en'], ['pt-BR', 'pt'], ['fre', 'fr'], ['Brazilian Portuguese', 'pt'], ['und', null], ['xyz', null]]) {
    assert.equal(toIso1(input), want, input);
  }
});

test('subtitle filename tags', () => {
  assert.deepEqual(parseSubtitleTags('.en.forced'), { lang: 'en', forced: true, hi: false });
  assert.deepEqual(parseSubtitleTags('2_English'), { lang: 'en', forced: false, hi: false });
  assert.deepEqual(parseSubtitleTags('.eng.sdh'), { lang: 'en', forced: false, hi: true });
  assert.deepEqual(parseSubtitleTags('.en.hi'), { lang: 'en', forced: false, hi: true });
  assert.equal(parseSubtitleTags('.hi').lang, 'hi'); // Hindi, not hearing-impaired
});

test('OpenSubtitles hash: size plus 64-bit word sums', async () => {
  const dir = tmp();
  const f = path.join(dir, 'zeros.bin');
  fs.writeFileSync(f, Buffer.alloc(200000));
  assert.equal(await openSubtitlesHash(f), (200000).toString(16).padStart(16, '0'));
  const b = Buffer.alloc(200000);
  b.writeBigUInt64LE(0xffffffffffffffffn, 0); // overflow must wrap at 64 bits
  fs.writeFileSync(f, b);
  assert.equal(await openSubtitlesHash(f), (200000 - 1).toString(16).padStart(16, '0'));
});

test('decodes Windows-1252 and UTF-8 with BOM', () => {
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
});

test('unzips a subtitle archive', (t) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n'.repeat(20));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
  try {
    execFileSync('zip', ['-q', 'pack.zip', 'a.srt', 'readme.txt'], { cwd: dir });
  } catch {
    return t.skip('zip command not available');
  }
  const files = unzip(fs.readFileSync(path.join(dir, 'pack.zip')));
  assert.deepEqual(files.map((f) => f.name).sort(), ['a.srt', 'readme.txt']);
  assert.match(files.find((f) => f.name === 'a.srt').data.toString(), /Hello/);
});

test('ranking: exact hash match wins; wrong episodes and languages are dropped', () => {
  const item = { rel: 'Show/Show.S01E02.1080p.WEB.mkv', kind: 'episode', parsed: parsePath('Show/Show.S01E02.1080p.WEB.mkv') };
  const r = rank(
    [
      { provider: 'subdl', release: 'Show.S01E02.1080p.WEB', lang: 'en', season: 1, episode: 2 },
      { provider: 'opensubtitles', release: 'other release', lang: 'en', hashMatch: true, season: 1, episode: 2 },
      { provider: 'subdl', release: 'Show.S01E03.1080p.WEB', lang: 'en', season: 1, episode: 3 },
      { provider: 'subdl', release: 'Show.S01E02.1080p.WEB', lang: 'fr', season: 1, episode: 2 },
    ],
    item,
    ['en']
  );
  assert.equal(r.length, 2);
  assert.equal(r[0].provider, 'opensubtitles');
});

test('season pack: picks the right episode file', () => {
  const item = { rel: 'Show.S02E05.mkv', kind: 'episode', parsed: parsePath('Show.S02E05.mkv') };
  const files = ['Show.S02E04.srt', 'Show.S02E05.srt', 'Show.S02E15.srt'].map((name) => ({ name, data: Buffer.from('') }));
  assert.equal(pickArchiveEntry(files, item).name, 'Show.S02E05.srt');
});

test('SRT to WebVTT', () => {
  assert.equal(srtToVtt('1\r\n00:00:01,000 --> 00:00:04,500\r\n{\\an8}Hi\r\n'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\nHi\n');
});

test('finds sidecar subtitles in all supported layouts', () => {
  const dir = tmp();
  const w = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  };
  w('Show/Show.S01E01.mkv');
  w('Show/Show.S01E02.mkv');
  w('Show/Show.S01E01.en.srt');
  w('Show/Show.S01E01.es.forced.srt');
  w('Show/Subs/Show.S01E01/2_English.srt');
  w('Show/Subs/Show.S01E02/3_French.srt');
  w('Show/unrelated.srt'); // two videos in the folder: not claimed by either
  w('Movie/Movie.2020.mkv');
  w('Movie/english.srt'); // single video in folder: claimed
  const lib = new Library(dir);
  const ep = lib.findSidecars(path.join(dir, 'Show/Show.S01E01.mkv'), 'x', false);
  const rel = (f) => path.relative(dir, f).split(path.sep).join('/');
  assert.deepEqual(ep.map((s) => [rel(s.file), s.lang, s.forced]).sort(), [
    ['Show/Show.S01E01.en.srt', 'en', false],
    ['Show/Show.S01E01.es.forced.srt', 'es', true],
    ['Show/Subs/Show.S01E01/2_English.srt', 'en', false],
  ]);
  const mv = lib.findSidecars(path.join(dir, 'Movie/Movie.2020.mkv'), 'y', true);
  assert.deepEqual(mv.map((s) => [path.basename(s.file), s.lang]), [['english.srt', 'en']]);
});
