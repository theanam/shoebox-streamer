// Filename / path → { show, season, episode, title, year } heuristics.

const JUNK = new RegExp(
  '\\b(' +
    [
      '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'dolby', 'vision',
      'bluray', 'blu ray', 'brrip', 'bdrip', 'webrip', 'web dl', 'webdl', 'web', 'hdtv', 'dvdrip', 'dvd', 'remux',
      'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', '10bit', '8bit', 'aac', 'ac3', 'eac3', 'dts',
      'ddp', 'dd5', 'atmos', 'truehd', 'flac', 'mp3', 'opus', '5 1', '7 1', '2 0', 'proper', 'repack', 'extended',
      'unrated', 'directors cut', 'imax', 'internal', 'limited', 'multi', 'dual audio', 'subbed', 'dubbed',
      'nf', 'amzn', 'dsnp', 'hmax', 'atvp', 'yts', 'yify', 'rarbg', 'eztv', 'ettv',
    ].join('|') +
    ')\\b.*$',
  'i'
);

const SEASON_DIR = /^(?:season|series|staffel|saison|temporada|s)[ ._-]*(\d{1,3})$/i;
const SPECIALS_DIR = /^(?:specials?|extras?|featurettes?)$/i;

export function cleanTitle(s) {
  return s
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ') // [group] {tags}
    .replace(/\((?!(19|20)\d\d\))[^)]*\)/g, ' ') // (1080p) but keep (1999)
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripJunk(s) {
  return s.replace(JUNK, '').replace(/[\s\-–:]+$/, '').trim();
}

function titleCase(s) {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s; // already has intentional casing
  return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

export function normKey(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\b(19|20)\d\d\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Bigram Dice similarity in [0,1]. */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

const EPISODE_PATTERNS = [
  // S01E02, s01e02e03, S01.E02, thisshows01e01 (no separator before the s)
  { re: /s(\d{1,3})[ ._-]*e(\d{1,4})(?:(?:-?e|-)(\d{1,4}))?(?!\d)/i, s: 1, e: 2, e2: 3 },
  // 1x02
  { re: /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?!\d)/i, s: 1, e: 2 },
  // Season 1 Episode 2
  { re: /season[ ._-]*(\d{1,3})[ ._-]*(?:episode|ep|e)[ ._-]*(\d{1,4})/i, s: 1, e: 2 },
];

// Episode without season: "Episode 5", "Ep05", "E05", "#05"
const EP_ONLY = /(?:^|[^a-z0-9])(?:episode|ep|e|#)[ ._-]*(\d{1,4})(?!\d)/i;
// Anime / generic trailing number: "Show - 01", "Show 01 [1080p]", "Show_01v2"
const TRAILING_NUM = /^(.*?\D)[ ._-]*-?[ ._-]*(\d{1,4})(?:v\d)?(?:[ ._-].*)?$/;

/**
 * @param {string} rel  path relative to library root, using '/' separators
 * @returns {{ kind:'episode'|'movie'|'maybe', show?:string, season?:number, episode?:number, episodeEnd?:number,
 *            title:string, year?:number, folderShow?:string, strength:number }}
 */
export function parsePath(rel) {
  const parts = rel.split('/');
  const file = parts.pop();
  const base = file.replace(/\.[^.]+$/, '');
  const dirs = parts;

  // Folder-derived context: nearest non-season folder is a show-name candidate.
  let folderSeason;
  let folderShow;
  for (let i = dirs.length - 1; i >= 0; i--) {
    const d = cleanTitle(dirs[i]);
    const m = d.match(SEASON_DIR);
    if (m) {
      if (folderSeason === undefined) folderSeason = parseInt(m[1], 10);
      continue;
    }
    if (SPECIALS_DIR.test(d)) {
      if (folderSeason === undefined) folderSeason = 0;
      continue;
    }
    // "Show Name Season 2" / "Show.S02.1080p" folder
    const sm = d.match(/^(.*?)[ ._-]+(?:season[ ._-]*|s)(\d{1,2})(?:\b|[ ._-]|$)/i);
    if (sm && sm[1].trim()) {
      if (folderSeason === undefined) folderSeason = parseInt(sm[2], 10);
      folderShow = titleCase(stripJunk(sm[1]));
    } else {
      folderShow = titleCase(stripJunk(d.replace(/\((19|20)\d\d\)/, '').trim())) || undefined;
    }
    break;
  }

  const cleaned = cleanTitle(base.replace(/[._]/g, ' '));

  for (const p of EPISODE_PATTERNS) {
    const m = base.match(p.re) || cleaned.match(p.re);
    if (!m) continue;
    const src = base.match(p.re) ? base : cleaned;
    const idx = src.indexOf(m[0]);
    let prefix = stripJunk(cleanTitle(src.slice(0, idx)));
    let after = stripJunk(cleanTitle(src.slice(idx + m[0].length))).replace(/^[\s\-–:]+/, '');
    const year = prefix.match(/\b((?:19|20)\d\d)\s*$/);
    if (year) prefix = prefix.slice(0, year.index).trim();
    return {
      kind: 'episode',
      strength: 3,
      show: titleCase(prefix) || folderShow || 'Unknown Show',
      folderShow,
      season: parseInt(m[p.s], 10),
      episode: parseInt(m[p.e], 10),
      episodeEnd: p.e2 && m[p.e2] ? parseInt(m[p.e2], 10) : undefined,
      title: after || undefined,
    };
  }

  const epOnly = cleaned.match(EP_ONLY);
  if (epOnly) {
    const prefix = stripJunk(cleaned.slice(0, epOnly.index));
    return {
      kind: 'episode',
      strength: 2,
      show: titleCase(prefix) || folderShow || 'Unknown Show',
      folderShow,
      season: folderSeason ?? 1,
      episode: parseInt(epOnly[1], 10),
      title: stripJunk(cleaned.slice(epOnly.index + epOnly[0].length)).replace(/^[\s\-–:]+/, '') || undefined,
    };
  }

  // Movie title + year?
  const ym = cleaned.match(/^(.*\S)[ (\[]+((?:19|20)\d\d)(?:[)\]\s]|$)/);
  const movieTitle = ym && ym[1].trim() ? stripJunk(ym[1]) : stripJunk(cleaned);
  const year = ym && ym[1].trim() ? parseInt(ym[2], 10) : undefined;

  // Trailing number → maybe an episode, decided later by sibling grouping.
  const strippedForNum = stripJunk(cleaned);
  const tn = strippedForNum.match(TRAILING_NUM);
  if (tn && !year && !/^(19|20)\d\d$/.test(tn[2])) {
    const prefix = tn[1].replace(/[\s\-–:#]+$/, '').trim();
    if (prefix) {
      return {
        kind: 'maybe',
        strength: 1,
        show: titleCase(prefix),
        folderShow,
        season: folderSeason ?? 1,
        episode: parseInt(tn[2], 10),
        movieTitle: titleCase(movieTitle),
      };
    }
  }

  // Bare number filename inside a show folder: "Show/03.mkv"
  if (/^\d{1,3}$/.test(strippedForNum) && folderShow) {
    return {
      kind: 'episode',
      strength: 2,
      show: folderShow,
      folderShow,
      season: folderSeason ?? 1,
      episode: parseInt(strippedForNum, 10),
    };
  }

  return { kind: 'movie', strength: 0, title: titleCase(movieTitle) || base, year, folderShow };
}

/** Natural compare ("ep2" < "ep10"). */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
