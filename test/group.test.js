import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, hash } from '../src/library.js';
import { parsePath } from '../src/parse.js';

function libWith(rels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-test-'));
  const lib = new Library(dir);
  for (const rel of rels) lib.items.set(hash(rel), { id: hash(rel), rel, ext: path.extname(rel), parsed: parsePath(rel) });
  lib.group();
  return lib;
}

test('glued and separated names group into one show in order', () => {
  const lib = libWith(['thisshows01e02.mkv', 'thisshows01e01.mkv', 'Thisshow S01E03.mkv']);
  assert.equal(lib.shows.size, 1);
  const [show] = lib.shows.values();
  assert.deepEqual(show.episodes.map((id) => lib.items.get(id).parsed.episode), [1, 2, 3]);
});

test('show folder name wins and seasons are ordered', () => {
  const lib = libWith(['Dark/Season 2/Dark.S02E01.mkv', 'Dark/Season 1/Dark.S01E02.mkv', 'Dark/Season 1/Dark.S01E01.mkv']);
  const [show] = lib.shows.values();
  assert.equal(show.name, 'Dark');
  assert.deepEqual(show.seasons, [1, 2]);
});

test('anime-style numbered siblings become a show; a lone one is a movie', () => {
  const lib = libWith(['Frieren/[Grp] Frieren - 01 [1080p].mkv', 'Frieren/[Grp] Frieren - 02 [1080p].mkv', 'Heat - 2.mkv']);
  assert.equal(lib.shows.size, 1);
  assert.equal(lib.items.get(hash('Heat - 2.mkv')).kind, 'movie');
});

test('different shows stay separate', () => {
  const lib = libWith(['Lost.S01E01.mkv', 'Lost.S01E02.mkv', 'Dark.S01E01.mkv']);
  assert.equal(lib.shows.size, 2);
});
