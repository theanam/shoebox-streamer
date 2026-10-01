// Language codes: normalize ISO 639-1/639-2 codes and English names to ISO 639-1 ("en").

const ISO1 = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'is', 'pl', 'cs', 'sk', 'sl', 'hu', 'ro', 'bg',
  'hr', 'sr', 'bs', 'mk', 'sq', 'el', 'tr', 'ru', 'uk', 'be', 'lt', 'lv', 'et', 'he', 'ar', 'fa', 'ur', 'hi', 'bn',
  'pa', 'ta', 'te', 'ml', 'kn', 'mr', 'gu', 'si', 'ne', 'th', 'vi', 'id', 'ms', 'tl', 'zh', 'ja', 'ko', 'ka', 'hy',
  'az', 'kk', 'uz', 'mn', 'km', 'lo', 'my', 'sw', 'am', 'af', 'ca', 'eu', 'gl', 'cy', 'ga', 'eo', 'la',
];

// ISO 639-2 (bibliographic and terminology) → 639-1
const ISO2 = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl',
  swe: 'sv', nor: 'no', nob: 'no', nno: 'no', dan: 'da', fin: 'fi', ice: 'is', isl: 'is', pol: 'pl', cze: 'cs',
  ces: 'cs', slo: 'sk', slk: 'sk', slv: 'sl', hun: 'hu', rum: 'ro', ron: 'ro', bul: 'bg', hrv: 'hr', scr: 'hr',
  srp: 'sr', scc: 'sr', bos: 'bs', mac: 'mk', mkd: 'mk', alb: 'sq', sqi: 'sq', gre: 'el', ell: 'el', tur: 'tr',
  rus: 'ru', ukr: 'uk', bel: 'be', lit: 'lt', lav: 'lv', est: 'et', heb: 'he', ara: 'ar', per: 'fa', fas: 'fa',
  urd: 'ur', hin: 'hi', ben: 'bn', pan: 'pa', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', mar: 'mr', guj: 'gu',
  sin: 'si', nep: 'ne', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', tgl: 'tl', fil: 'tl', chi: 'zh',
  zho: 'zh', jpn: 'ja', kor: 'ko', geo: 'ka', kat: 'ka', arm: 'hy', hye: 'hy', aze: 'az', kaz: 'kk', uzb: 'uz',
  mon: 'mn', khm: 'km', lao: 'lo', bur: 'my', mya: 'my', swa: 'sw', amh: 'am', afr: 'af', cat: 'ca', baq: 'eu',
  eus: 'eu', glg: 'gl', wel: 'cy', cym: 'cy', gle: 'ga', epo: 'eo', lat: 'la',
};

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
const BY_NAME = new Map();
for (const code of ISO1) {
  const name = displayNames.of(code);
  if (name) BY_NAME.set(name.toLowerCase(), code);
}
// Common alternative spellings seen in subtitle file names.
for (const [k, v] of Object.entries({
  farsi: 'fa', persian: 'fa', brazilian: 'pt', 'brazilian portuguese': 'pt', portuguesebr: 'pt', ptbr: 'pt',
  chinese: 'zh', mandarin: 'zh', cantonese: 'zh', simplified: 'zh', traditional: 'zh', espanol: 'es', español: 'es',
  francais: 'fr', français: 'fr', deutsch: 'de', norwegian: 'no', bokmal: 'no', serbian: 'sr', croatian: 'hr',
  indonesian: 'id', malay: 'ms', filipino: 'tl', tagalog: 'tl',
})) {
  BY_NAME.set(k, v);
}

/** Normalize a code or name ("eng", "en", "pt-BR", "English") to ISO 639-1, or null. */
export function toIso1(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v || v === 'und') return null;
  if (ISO1.includes(v)) return v;
  if (ISO2[v]) return ISO2[v];
  const base = v.split(/[-_]/)[0];
  if (base !== v && (ISO1.includes(base) || ISO2[base])) return ISO2[base] || base;
  return BY_NAME.get(v) || null;
}

export function languageName(code) {
  const iso = toIso1(code);
  if (!iso) return code || undefined;
  try {
    return displayNames.of(iso) || iso;
  } catch {
    return iso;
  }
}

/**
 * Pull language + flags out of a subtitle filename remainder, e.g. ".en.forced", "_English_SDH", "2_Eng".
 * @returns {{ lang: string|null, forced: boolean, hi: boolean }}
 */
export function parseSubtitleTags(text) {
  const tokens = String(text || '')
    .toLowerCase()
    .split(/[\s._\-()[\]]+/)
    .filter(Boolean);
  let lang = null;
  let forced = false;
  let hi = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'forced' || t === 'foreign') forced = true;
    // "hi" is also Hindi: it means hearing-impaired only after a language ("en.hi").
    else if (t === 'sdh' || t === 'cc' || (t === 'hi' && lang)) hi = true;
    else if (!lang) {
      // two-word names, e.g. "brazilian portuguese"
      const pair = tokens[i + 1] ? toIso1(`${t} ${tokens[i + 1]}`) : null;
      lang = pair || (t.length >= 2 && !/^\d+$/.test(t) ? toIso1(t) : null);
    }
  }
  return { lang, forced, hi };
}
