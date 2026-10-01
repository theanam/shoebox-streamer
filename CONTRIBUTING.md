# Contributing to Shoebox

## Running from source

```sh
git clone https://github.com/theanam/shoebox-streamer.git
cd shoebox-streamer
npm install
npm start -- ~/Movies -v     # serve a folder with verbose logging
npm test
```

To get a `shoebox` command that runs your working copy, run `npm link`. If your global npm folder needs admin rights,
symlink `bin/shoebox.js` into a folder on your `PATH` instead. Backend changes need a restart. The web UI in `public/`
is plain ES modules with no build step, so refreshing the browser is enough.

`docs/architecture.md` describes how the pieces fit together: library scanning, the playback decision,
on-demand HLS and the subtitle providers.

## Versioning and releases

Shoebox follows [semver](https://semver.org/):

- **patch** (`0.2.1`): bug fixes
- **minor** (`0.3.0`): new features
- **major** (`1.0.0`): breaking changes to CLI flags, the config file format, or URLs other devices may have saved

Every change to `bin/`, `src/`, `public/` or `package.json` needs a version bump and a `CHANGELOG.md` entry:

```sh
npm version minor --no-git-tag-version   # or patch / major
# then add a "## [x.y.z] - YYYY-MM-DD" section to CHANGELOG.md
```

CI checks both on pull requests. When a commit reaches `main` with a version that isn't on npm yet, the
[release workflow](.github/workflows/release.yml) runs the tests, publishes to npm with provenance, and creates a
GitHub release from the changelog section. There's nothing to tag by hand.

## Notes

- `uint8-util` is pinned to `2.2.6` as a direct dependency on purpose: 2.3.x changed `arr2hex` in a way that crashes
  webtorrent 2.8.x when adding a magnet link. A direct dependency, unlike `overrides`, also applies to global installs.
  Remove the pin once webtorrent is fixed upstream.
- `ffmpeg-static`, `ffprobe-static` and `webtorrent` are optional dependencies. Shoebox has to keep working when
  they fail to install.
