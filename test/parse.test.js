import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath } from '../src/parse.js';

const cases = [
  ['thisshows01e01.mkv', { kind: 'episode', show: 'Thisshow', season: 1, episode: 1 }],
  ['My Show/Season 1/My.Show.S01E02.720p.mp4', { kind: 'episode', show: 'My Show', season: 1, episode: 2 }],
  ['Breaking.Bad.S02E03.Bit.by.a.Dead.Bee.1080p.WEB-DL.x264.mkv', { kind: 'episode', show: 'Breaking Bad', season: 2, episode: 3, title: 'Bit by a Dead Bee' }],
  ['The Office (US)/Season 3/3x07 - Branch Wars.avi', { kind: 'episode', season: 3, episode: 7, title: 'Branch Wars' }],
  ['Game of Thrones Season 1 Episode 9.mp4', { kind: 'episode', show: 'Game of Thrones', season: 1, episode: 9 }],
  ['Show.S01E01-E02.mkv', { kind: 'episode', episode: 1, episodeEnd: 2 }],
  ['Firefly/05.mkv', { kind: 'episode', show: 'Firefly', episode: 5 }],
  ['Show Name S02/Show Name - Episode 4.mkv', { kind: 'episode', show: 'Show Name', season: 2, episode: 4 }],
  ['[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv', { kind: 'maybe', show: 'Frieren', episode: 5 }],
  ['The.Matrix.1999.1080p.BluRay.x264.mp4', { kind: 'movie', title: 'The Matrix', year: 1999 }],
  ['Blade Runner 2049 (2017).mkv', { kind: 'movie', title: 'Blade Runner 2049', year: 2017 }],
  ['1917 (2019).mkv', { kind: 'movie', title: '1917', year: 2019 }],
];

for (const [path, expected] of cases) {
  test(`parse ${path}`, () => {
    const r = parsePath(path);
    for (const [k, v] of Object.entries(expected)) assert.equal(r[k], v, `${k} of ${path}`);
  });
}
