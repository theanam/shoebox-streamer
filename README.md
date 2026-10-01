# 📦 Shoebox

Turn any folder of videos into a streaming server for your home network. Run one command, then watch
from your phone, tablet, TV browser or laptop. Built so you can watch the shows on your computer from
a phone propped on the treadmill.

```sh
cd ~/Movies
npx shoebox-streamer
```

or install it once:

```sh
npm install -g shoebox-streamer
shoebox
```

Then open the address it prints on any device on the same Wi-Fi (or scan the QR code in the terminal):

```
  📦 Shoebox v0.1.0  serving /Users/you/Movies

  Network name: http://shoebox.local:7171
  On your LAN:  http://192.168.0.134:7171
```

## What it does

- **Finds your shows.** Episodes are grouped into shows and sorted by season and episode, whether they're
  named `Show.S01E02.mkv`, `thisshows01e02.mkv`, `1x02`, `Season 1 Episode 2`, `Show/Season 1/03.mkv`
  or anime-style `[Group] Show - 02 (1080p).mkv`. Slight spelling differences are merged.
- **Posters and thumbnails.** Show posters come from TVMaze and movie posters from Wikipedia (no API keys).
  Episode thumbnails are grabbed from the video itself. Pass `--tmdb-key` for TMDB artwork, or `--offline` to skip lookups.
- **Plays on every device.** The browser reports which codecs it can decode, and the server picks one of three paths:
  - **Direct Play**: the original file, streamed with HTTP range requests (no CPU cost)
  - **Remux**: the video is copied untouched and only the container/audio are converted (e.g. MKV + AC3 → HLS)
  - **Transcode**: converted on the fly to H.264/AAC HLS, using the hardware encoder when one is available (VideoToolbox, NVENC, QSV, VAAPI)

  Seeking works anywhere, even into parts that haven't been converted yet. If a device claims it can play a
  file directly and then fails, the player switches to server conversion on its own.
- **A full-featured player.** Fullscreen, picture-in-picture, playback speed (0.5×–2×), subtitles (embedded or
  `.srt`/`.vtt`/`.ass` next to the video), audio track and quality selection, an episode list, autoplay of the
  next episode, double-tap to skip on phones, keyboard shortcuts, lock-screen controls, and it keeps the screen awake.
- **Remembers where you were.** Progress is saved in each device's browser, and "Continue watching" picks up where you left off.
- **Dark theme by default**, with a light theme one tap away.

### Torrents (bonus)

```sh
shoebox "magnet:?xt=urn:btih:..."     # or: shoebox something.torrent
```

…or open **Torrents** in the web UI and paste a magnet link or drop a `.torrent` file. Files download into
`Torrents/` inside the served folder, and you can start watching before the download finishes.

### VLC (bonus)

Every video has a direct stream URL that VLC can play, whatever the format:

- **Open in VLC** in the player's ⋯ menu, which launches the VLC app on iOS and Android
- **VLC playlist** on a show page, an `.m3u` of every episode in order, so VLC plays them back to back
- **Copy stream URL**, then in VLC use *Open Network Stream*

## Options

```
shoebox [folder|magnet|file.torrent] [options]

  -p, --port <n>       port to listen on (default 7171, next free port if taken)
  -n, --name <name>    mDNS name, reachable as http://<name>.local (default "shoebox")
      --host <addr>    interface to bind (default 0.0.0.0)
      --open           open the web UI on this computer
      --no-mdns        don't advertise via mDNS/Bonjour
      --no-watch       don't watch the folder for new files
      --offline        don't fetch artwork from the internet
      --tmdb-key <k>   TMDB API key (or env TMDB_API_KEY)
  -v, --verbose        log every ffmpeg job
```

Environment overrides: `SHOEBOX_FFMPEG`, `SHOEBOX_FFPROBE` (binary paths) and `SHOEBOX_ENCODER` (e.g. `libx264`).

## Requirements

- Node.js 18.17+
- ffmpeg/ffprobe. A system install (`brew install ffmpeg`, `apt install ffmpeg`, `winget install ffmpeg`) is used
  when present. Otherwise the bundled `ffmpeg-static` binaries are used.

## Good to know

- Shoebox stores probe data, thumbnails and posters in a hidden `.shoebox/` folder inside the served folder
  (or `~/.cache/shoebox` if that folder is read-only). Delete it to start fresh.
- If `shoebox.local` doesn't resolve on a device (some older Android versions), use the IP address instead.
- The first time you run it, macOS or Windows may ask whether to allow incoming connections. Allow it, or other devices can't connect.
- Shoebox has no login. Anyone on your network can see and play the folder, so only run it on networks you trust.
- HEVC/H.265 inside MKV is transcoded, even for devices that support HEVC (HLS remuxing is H.264-only for now).

## Development

```sh
npm install
npm start -- ~/Movies -v
npm test
```

The frontend is plain ES modules in `public/` with no build step. See `PLAN.md` for the architecture.

`uint8-util` is pinned to `2.2.6` as a direct dependency on purpose: 2.3.x changed `arr2hex` in a way that crashes
webtorrent 2.8.x when adding a magnet link. A direct dependency (unlike `overrides`) also applies to global installs.
Remove the pin once webtorrent is fixed upstream.
