import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULTS, redacted } from '../src/config.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shoebox-conf-')), '.shoebox.conf');

test('missing file loads defaults', () => {
  const r = loadConfig(file());
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.config, DEFAULTS);
});

test('corrupt file loads defaults', () => {
  const f = file();
  fs.writeFileSync(f, '{ not json');
  const r = loadConfig(f);
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.config, DEFAULTS);
});

test('wrong types fall back per field; valid fields are kept', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ port: 'abc', name: 'treadmill', mdns: 'yes', subtitles: { languages: ['EN', 'es'], subdl: { apiKey: 42 } }, extra: 1 }));
  const { config, status } = loadConfig(f);
  assert.equal(status, 'loaded');
  assert.equal(config.port, 7171);
  assert.equal(config.name, 'treadmill');
  assert.equal(config.mdns, true);
  assert.deepEqual(config.subtitles.languages, ['en', 'es']);
  assert.equal(config.subtitles.subdl.apiKey, '');
  assert.equal(config.extra, undefined);
});

test('save round-trips and is private to the user', () => {
  const f = file();
  const cfg = structuredClone(DEFAULTS);
  cfg.subtitles.openSubtitles.apiKey = 'abcdef123456';
  saveConfig(cfg, f);
  assert.deepEqual(loadConfig(f).config, cfg);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(redacted(cfg).subtitles.openSubtitles.apiKey.endsWith('3456'), true);
  assert.equal(redacted(cfg).subtitles.openSubtitles.apiKey.includes('abcdef'), false);
});
