<p align="center">
  <img src="https://raw.githubusercontent.com/theanam/shoebox-streamer/main/docs/logo.svg" width="112" alt="Shoebox logo" />
</p>

<h1 align="center">Shoebox</h1>

<p align="center">
  <b>Stream your local videos and torrents to any phone, tablet or TV on your Wi-Fi with one command.</b><br />
  Run it in a folder of videos, or give it a magnet link, and press play. No accounts, no cloud, no setup.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/shoebox-streamer"><img src="https://img.shields.io/npm/v/shoebox-streamer?color=ef3b3b" alt="npm version" /></a>
  <a href="https://github.com/theanam/shoebox-streamer/actions/workflows/ci.yml"><img src="https://github.com/theanam/shoebox-streamer/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/node/v/shoebox-streamer" alt="Node version" />
  <img src="https://img.shields.io/npm/l/shoebox-streamer" alt="MIT license" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/theanam/shoebox-streamer/main/docs/screenshots/library.jpg" alt="The Shoebox library: continue watching and movies with cover art" />
</p>

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```sh
cd ~/Movies
npx shoebox-streamer
```

Shoebox prints an address and a QR code. Open the address on any device on the same network:

```
  📦 Shoebox v0.4.0  serving /Users/you/Movies

  Network name: http://shoebox.local:7171
  On your LAN:  http://192.168.0.134:7171
```

To have the `shoebox` command always available, install it globally:

```sh
npm install -g shoebox-streamer
shoebox            # serves the current folder
shoebox ~/Videos   # or any folder
```

## Features

**Your folder, organized.** Shoebox recognizes episodes and groups them into shows with seasons, in the right order,
however they're named: `Show.S01E02.mkv`, `shows01e02.mp4`, `1x02`, `Season 1/03.mkv`, `[Group] Show - 02 (1080p).mkv`.
Movies get posters and shows get episode thumbnails. New files appear while it's running.

**Plays on everything.** Each device tells Shoebox which formats it can decode. Files it can handle stream untouched.
Anything else is converted on the fly (MKV, AVI, HEVC, AC3/DTS audio, 10-bit video), using your computer's
hardware encoder when it has one. You can seek anywhere instantly, even in the middle of a conversion.

**A player built for phones.** Big touch controls, double-tap to skip, playback speed, fullscreen and picture-in-picture,
an episode list, autoplay of the next episode, and the screen stays awake. Each device remembers where you left off.
There's a dark theme by default and a light one, and you can add it to your home screen as an app.

<p align="center">
  <img src="https://raw.githubusercontent.com/theanam/shoebox-streamer/main/docs/screenshots/player.jpg" width="72%" alt="The Shoebox player" />
  <img src="https://raw.githubusercontent.com/theanam/shoebox-streamer/main/docs/screenshots/mobile.jpg" width="24%" alt="Shoebox on a phone" />
</p>

**Subtitles that just show up.** Subtitles inside the video or in files next to it are picked automatically in your
language. If there aren't any, Shoebox can download them from OpenSubtitles or SubDL ([see below](#subtitles)).

**Works with VLC.** Every video has a direct stream link that VLC can open, and every show has a playlist that plays
the episodes back to back. "Open in VLC" in the player launches the VLC app on iPhone and Android.

**Torrents too.** Paste a magnet link (or drop a `.torrent` file) in the web page, or pass it on the command line, and
start watching while it downloads. Downloads are saved to a `Torrents` folder inside the folder you're serving.
Torrents last for the session: to continue an unfinished download later, add the same link again.

## Subtitles

Shoebox picks a subtitle in this order:

1. The language you last chose on that device, then your preferred languages
2. Subtitle files next to the video: `Movie.en.srt`, `Movie.English.forced.srt`, `Subs/Movie/2_English.srt`, or any
   subtitle in a folder that contains just that one video
3. Subtitle tracks inside the video file

To download missing subtitles automatically, get a free API key from one or both of these services, then run `shoebox config`:

- **[OpenSubtitles](https://www.opensubtitles.com/en/consumers)**: the largest catalogue, and it finds subtitles made for your exact file.
  The free tier allows about 20 downloads a day if you also enter your username and password.
- **[SubDL](https://subdl.com)**: much higher free limits. Your API key is under your profile once you sign up.

Downloaded subtitles are saved next to the video, so each one is only fetched once. The subtitle menu in the player
also lets you search manually and adjust the timing if a subtitle is out of sync.

## Settings

```sh
shoebox config        # step-by-step setup
shoebox config show   # print current settings (API keys masked)
```

Settings are stored in `~/.shoebox.conf` (on Windows, `C:\Users\<you>\.shoebox.conf`). They include your
preferred port, network name, subtitle languages and API keys. Command-line options override them for a single run:

| Option | Default | |
|---|---|---|
| `-p, --port <n>` | `7171` | Port to listen on. If it's taken, the next free one is used. |
| `-n, --name <name>` | `shoebox` | Network name: `http://<name>.local` |
| `--password` | | Ask for a password for this run. Devices must enter it to open Shoebox. |
| `--no-password` | | Turn off the password from your settings for this run |
| `--open` | | Open the web page on this computer |
| `--offline` | | Don't fetch posters or subtitles from the internet |
| `--no-mdns` | | Don't announce the `.local` name on the network |
| `--no-watch` | | Don't watch the folder for new files |
| `--tmdb-key <key>` | | Use [TMDB](https://www.themoviedb.org/settings/api) for posters |
| `-v, --verbose` | | Log every conversion |

```sh
shoebox "magnet:?xt=urn:btih:…"    # serve the current folder and download a torrent
shoebox ~/Downloads/film.torrent   # same, from a .torrent file
```

## Password protection

Without a password, anyone on your network can open Shoebox. You can require one in two ways:

- **Always:** run `shoebox config` and set a web page password. It's saved as a hash, not in plain text, and devices
  stay signed in for 30 days or until you change the password.
- **For one run:** start with `shoebox --password` and type a password in the terminal. It overrides the saved password
  for that run, and every device is signed out when Shoebox stops.

Devices see a sign-in page until they enter the password. Links for VLC and other players include a key, so they
keep working without signing in. After five wrong guesses, Shoebox makes that device wait before trying again.

## Requirements

- **Node.js 18+** on macOS, Linux or Windows
- **ffmpeg**. If it's installed (`brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install ffmpeg`), Shoebox
  uses it. Otherwise it falls back to a copy bundled with the package.

## Troubleshooting

**Other devices can't connect.** Make sure they're on the same Wi-Fi. The first time you run Shoebox, macOS and Windows
ask whether to allow incoming connections. Choose *Allow*. Some guest networks and office networks block
connections between devices.

**`shoebox.local` doesn't open.** A few devices (mostly older Android phones) don't support `.local` names. Use the
IP address instead, or scan the QR code in the terminal.

**Playback is choppy.** Pick a lower quality in the player's settings menu (720p works well on phones). If the badge in
the top bar says *Transcode*, your computer is converting the video live, which needs more CPU.

**Starting over.** Shoebox keeps thumbnails and file information in a hidden `.shoebox` folder inside the folder you
serve. Delete it to rebuild everything.

## Privacy & security

Everything stays on your network. The only outside requests are poster lookups (TVMaze, Wikipedia) and subtitle
searches, and you can turn both off with `--offline`. Unless you [set a password](#password-protection), anyone on your
network can browse and play the folder you're serving. The password keeps out other people on your network. The
connection itself is plain HTTP, though, so use Shoebox on networks you trust.

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
