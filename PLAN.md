# Shoebox — plan

`npx shoebox` (or `npm i -g shoebox-streamer` then `shoebox`) inside a folder of videos →
a LAN video server with a phone-friendly web player at `http://shoebox.local:7171`.

## 1. CLI & networking
- `shoebox [folder|magnet|file.torrent] [--port 7171] [--name shoebox] [--no-mdns] [--offline] [--tmdb-key KEY]`
- Binds `0.0.0.0` (one port serves UI, API, media and HLS). If the port is taken, it tries the next one.
- **mDNS**: `bonjour-service` publishes `_http._tcp` with hostname `shoebox.local`, so
  `http://shoebox.local:PORT` resolves on iOS, macOS, Windows 10+, Linux/avahi and modern Android.
  The raw LAN IP is printed too, plus a **terminal QR code** you can scan from the phone.
- ffmpeg: uses the system `ffmpeg`/`ffprobe` if they're on PATH, otherwise the optional `ffmpeg-static`/`ffprobe-static` packages.

## 2. Library scan
- Recursive walk for video extensions. Skips hidden folders and `.shoebox/` (the cache dir it creates in the served folder; falls back to the OS cache dir if the folder is read-only).
- **Name parsing**: `S01E02`, `s01e02` glued to the title (`thisshows01e01`), `1x02`, `Season 1 Episode 2`,
  `Season N/` folders, anime style `[Group] Show - 01 (1080p)`, trailing numbers when siblings share a prefix.
- **Grouping**: normalized title key → fuzzy merge (bigram Dice ≥ 0.85, prefix matching) → when a parent
  folder name matches, its nicer spelling becomes the display name. Natural sort by season/episode. Anything left over is a movie.
- **ffprobe** every file (cached by path+size+mtime): container, codecs, profile, bit depth, audio and subtitle tracks, duration.
- **Artwork** (background queue): TVMaze (no key needed) for show posters, Wikipedia's API (no key needed) for movie posters,
  TMDB if a key is given, and an ffmpeg frame grab at about 15% for episode thumbnails and as a fallback. All cached on disk.
- Watches the folder (fs.watch, debounced) and rescans on changes.

## 3. Playback decision (device probe → direct / remux / transcode)
The client reports its capabilities via `MediaSource.isTypeSupported` / `canPlayType` (h264 baseline→high, High10,
hevc, vp9, av1, aac, mp3, opus, flac, ac3, eac3; mp4/webm/HLS support). For each title, the server picks:
1. **Direct**: the container, video codec/profile and audio codec all play natively → raw file with HTTP Range.
2. **Remux (HLS, video copy)**: video is fine but the container or audio isn't (e.g. MKV h264 + AC3). Segment
   boundaries come from a cached keyframe index (built in the background), audio → AAC.
3. **Transcode (HLS)**: anything else, or a quality cap the user picked (1080/720/480). Hardware encoder when available
   (VideoToolbox / NVENC / QSV / VAAPI, test-encoded at startup), otherwise libx264 veryfast. Forced keyframes on a 4s grid.
- The HLS playlist is a full VOD playlist generated up front, so the scrub bar shows the real duration and seeking works
  anywhere. Segments are produced on demand: if a request lands far from the running ffmpeg job, the job is killed and
  restarted at that segment (`-ss` + `-copyts` keeps timestamps consistent). Idle jobs are killed after 30s and temp dirs cleaned up.
- iOS Safari → native HLS; everyone else → hls.js.
- Subtitles: embedded text subs and sidecar `.srt/.vtt/.ass` → WebVTT on demand.

## 4. Web UI (vanilla ES modules, no build step, hls.js vendored)
- Dark theme by default, light toggle (persisted). Responsive, works well on phones.
- Home: Continue Watching, Shows, Movies, fuzzy search.
- Show page: season tabs, episode list with thumbnails, progress bars, watched marks.
- Player: custom controls. Play/pause, scrub bar with buffered range and hover time, ±10s, volume, **playback speed**,
  subtitles, audio track, quality, PiP, fullscreen, episode drawer, prev/next, autoplay next with countdown, resume,
  keyboard shortcuts, double-tap to seek on mobile, Screen Wake Lock, and a playback-mode badge (Direct/Remux/Transcode + reason).
- Progress is stored in browser localStorage (marked watched at ≥ 92%).

## 5. Bonus: torrents
- Optional `webtorrent` dependency, lazy-loaded. If it isn't installed, the feature turns itself off.
- Add a torrent from the CLI argument or from the UI (magnet text or .torrent upload). Files download into `<folder>/Torrents/`.
- Stream while downloading: direct play reads from the torrent with priority on the requested pieces, and
  transcode reads from an internal HTTP range URL. Finished downloads become normal library items.

## 6. Bonus: VLC
- Every item has a direct stream URL (VLC plays any codec), an "Open in VLC" link (`vlc://`) for the iOS/Android VLC apps,
  and an `.m3u` playlist per show/season so VLC plays episodes back to back.

## Layout
```
bin/shoebox.js          CLI entry
src/server.js           HTTP server + routing
src/library.js          scan, parse, group, probe cache
src/parse.js            filename → {show, season, episode, title, year}
src/ffmpeg.js           binary resolution, probe, thumbnails, keyframes, hwaccel detection
src/hls.js              on-demand HLS session manager
src/decide.js           capability → playback mode
src/artwork.js          TVMaze / Wikipedia / TMDB fetch + cache
src/torrent.js          webtorrent integration
src/mdns.js             bonjour publish
public/                 SPA (index.html, app.js, player.js, styles.css)
```
