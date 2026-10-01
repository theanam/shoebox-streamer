#!/usr/bin/env node
// CI guard: if shipped code changed relative to <base-ref>, the version must go up (semver)
// and CHANGELOG.md must have a section for it.
//   node scripts/check-version.mjs origin/main
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const base = process.argv[2] || 'origin/main';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(v || '');
  if (!m) throw new Error(`not a semver version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
};
const gt = (a, b) => {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] > b[k];
  if (a.pre === b.pre) return false;
  if (!a.pre) return true; // 1.0.0 > 1.0.0-beta
  if (!b.pre) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
};

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let baseVersion;
try {
  baseVersion = JSON.parse(git('show', `${base}:package.json`)).version;
} catch {
  console.log(`No package.json on ${base}; nothing to compare.`);
  process.exit(0);
}

const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
const shipped = changed.filter((f) => /^(bin|src|public)\//.test(f) || f === 'package.json');
const errors = [];

if (shipped.length && !gt(parse(pkg.version), parse(baseVersion))) {
  errors.push(
    `Shipped files changed but the version is still ${pkg.version} (base: ${baseVersion}).\n` +
      `  Bump it: npm version patch|minor|major --no-git-tag-version\n` +
      `  Changed: ${shipped.slice(0, 10).join(', ')}${shipped.length > 10 ? ', …' : ''}`
  );
}
const changelog = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
if (pkg.version !== baseVersion && !changelog.includes(`## [${pkg.version}]`)) {
  errors.push(`CHANGELOG.md has no "## [${pkg.version}]" section.`);
}

if (errors.length) {
  console.error(errors.map((e) => '✗ ' + e).join('\n\n'));
  process.exit(1);
}
console.log(`✓ version ${baseVersion} → ${pkg.version}${shipped.length ? '' : ' (no shipped files changed)'}`);
