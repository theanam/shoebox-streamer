#!/usr/bin/env node
// Print the CHANGELOG.md section for a version (default: package.json version).
import fs from 'node:fs';

const version = process.argv[2] || JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const text = fs.readFileSync('CHANGELOG.md', 'utf8');
const start = text.indexOf(`## [${version}]`);
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const rest = text.slice(start);
const next = rest.indexOf('\n## [', 1);
const section = (next < 0 ? rest : rest.slice(0, next)).split('\n').slice(1).join('\n').trim();
console.log(section);
