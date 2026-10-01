# Changelog

All notable changes to this project are documented here. Shoebox follows [Semantic Versioning](https://semver.org/):
patch releases for fixes, minor releases for new features, and a major release for breaking changes
(CLI flags, config format, or URLs that other devices may have saved).

## [0.2.1] - 2026-10-02

### Changed
- Shorter package description: "Stream your local videos or torrents to any device on your network."

## [0.2.0] - 2026-10-02

### Added
- `shoebox config`: an interactive setup wizard that saves to `~/.shoebox.conf` (`%USERPROFILE%\.shoebox.conf` on
  Windows; override with `SHOEBOX_CONFIG`). `shoebox config show` prints it with secrets masked, and `shoebox config path` prints its location.
  Settings apply on every run, a missing or unreadable file falls back to defaults, and command-line flags still win.
- Online subtitles from OpenSubtitles (exact matches via file hash) and SubDL, using your own free API keys.
  They download automatically when a video has nothing local in your languages, or you can search from the
  player's subtitle menu. Results are saved next to the video as `<name>.<lang>.srt`.
- Subtitle discovery: files in `Subs/`/`Subtitles/` folders (including `Subs/<episode>/2_English.srt` release
  layouts), any subtitle in a folder that holds a single video, and language/forced/SDH tags read from filenames.
- Automatic subtitle selection: your last choice, then your configured languages, then files beside the video,
  then default or forced embedded tracks. Turning subtitles off is remembered.
- A subtitle timing control in the player (±0.5s steps).

### Changed
- New logo, plus PNG icons so "Add to Home Screen" on iPhone shows the logo.
- Durations under a minute show in seconds instead of "0m".

### Fixed
- Movie posters for films whose Wikipedia summary doesn't mention the release year.
- Subtitle files in Windows-1252 or UTF-16 encodings now display correctly.
- Editing or replacing a subtitle file takes effect without clearing the cache.

## [0.1.0] - 2026-10-02

### Added
- First version: LAN video server with mDNS (`shoebox.local`), show detection, artwork, direct/remux/transcode
  HLS playback, mobile-friendly player, torrent streaming and VLC playlists.
