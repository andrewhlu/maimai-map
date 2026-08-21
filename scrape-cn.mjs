// Scrapes Wahlap's mainland-China arcade locator (the Chinese licensee that
// runs maimai DX and CHUNITHM in mainland China — separate from SEGA's
// global location.am-all.net listings) and merges the results into
// arcades.json. Wahlap's API returns no coordinates, so every China arcade
// is initially plotted at its province centroid; geocode.mjs / geocode-
// google.mjs upgrade those to street-level coords later.
//
// Usage: node scrape-cn.mjs
// Requires: Node.js >= 18 (for global fetch).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ENDPOINTS = [
  { variant: 'maimai_cn',   url: 'https://sega-register.wahlap.net/api/sega/maidx/rest/location' },
  { variant: 'chunithm_cn', url: 'https://sega-register.wahlap.net/api/sega/midtr/rest/location' },
];
const PAGE_URLS = {
  maimai_cn:   'http://wc.wahlap.net/maidx/location/index.html',
  chunithm_cn: 'http://wc.wahlap.net/chunithm/location/index.html',
};
const ARCADES_FILE = new URL('./arcades.json', import.meta.url);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COUNTRY_CODE = 1100;

// Wahlap's `province` field returns the Chinese-language name. Map each to:
//   pinyin   — English/pinyin name used in arcade.prefecture
//   centroid — [lat, lon] in WGS-84, used as the no-match geocode fallback
// Centroids are public reference values (province administrative center).
const PROVINCES = {
  '北京':   { pinyin: 'Beijing',        centroid: [39.9042, 116.4074] },
  '上海':   { pinyin: 'Shanghai',       centroid: [31.2304, 121.4737] },
  '天津':   { pinyin: 'Tianjin',        centroid: [39.3434, 117.3616] },
  '重庆':   { pinyin: 'Chongqing',      centroid: [29.5630, 106.5516] },
  '广东':   { pinyin: 'Guangdong',      centroid: [23.3790, 113.7633] },
  '江苏':   { pinyin: 'Jiangsu',        centroid: [32.9711, 119.4550] },
  '山东':   { pinyin: 'Shandong',       centroid: [36.3427, 118.1498] },
  '浙江':   { pinyin: 'Zhejiang',       centroid: [29.1832, 120.0934] },
  '河南':   { pinyin: 'Henan',          centroid: [33.8818, 113.6140] },
  '湖北':   { pinyin: 'Hubei',          centroid: [30.9756, 112.2707] },
  '四川':   { pinyin: 'Sichuan',        centroid: [30.6516, 102.7126] },
  '湖南':   { pinyin: 'Hunan',          centroid: [27.6104, 111.7088] },
  '安徽':   { pinyin: 'Anhui',          centroid: [31.8612, 117.2272] },
  '河北':   { pinyin: 'Hebei',          centroid: [38.0428, 114.5149] },
  '福建':   { pinyin: 'Fujian',         centroid: [26.0789, 117.9874] },
  '辽宁':   { pinyin: 'Liaoning',       centroid: [41.8357, 123.4290] },
  '江西':   { pinyin: 'Jiangxi',        centroid: [27.6140, 115.7221] },
  '广西':   { pinyin: 'Guangxi',        centroid: [23.7320, 108.3274] },
  '陕西':   { pinyin: 'Shaanxi',        centroid: [35.1956, 108.8717] },
  '山西':   { pinyin: 'Shanxi',         centroid: [37.5777, 112.2922] },
  '云南':   { pinyin: 'Yunnan',         centroid: [25.0389, 101.7193] },
  '黑龙江': { pinyin: 'Heilongjiang',   centroid: [47.5057, 128.0911] },
  '内蒙古': { pinyin: 'Inner Mongolia', centroid: [44.0935, 113.9448] },
  '吉林':   { pinyin: 'Jilin',          centroid: [43.6661, 126.1923] },
  '贵州':   { pinyin: 'Guizhou',        centroid: [26.8154, 106.8748] },
  '新疆':   { pinyin: 'Xinjiang',       centroid: [41.7678, 85.6147] },
  '海南':   { pinyin: 'Hainan',         centroid: [19.5664, 109.9497] },
  '甘肃':   { pinyin: 'Gansu',          centroid: [37.8099, 101.5639] },
  '宁夏':   { pinyin: 'Ningxia',        centroid: [37.2692, 106.1709] },
  '青海':   { pinyin: 'Qinghai',        centroid: [35.7452, 95.9956] },
  '西藏':   { pinyin: 'Tibet',          centroid: [29.6520, 91.1721] },
};

async function fetchEndpoint(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function buildRawEntries(payload, variant) {
  const out = [];
  for (const e of payload) {
    const meta = PROVINCES[e.province];
    if (!meta) {
      throw new Error(
        `Unknown province "${e.province}" in Wahlap data (arcade "${e.arcadeName}"). ` +
        `Update the PROVINCES table in scrape-cn.mjs.`
      );
    }
    out.push({
      variant,
      wahlap_id: e.id,
      placeId: e.placeId,
      province_zh: e.province,
      province: meta.pinyin,
      centroid: meta.centroid,
      name: e.arcadeName,
      address: e.address,
    });
  }
  return out;
}

function mergeRaw(rawEntries) {
  // Merge by wahlap_id — same physical arcade across maimai/chunithm China.
  const byId = new Map();
  for (const r of rawEntries) {
    let arc = byId.get(r.wahlap_id);
    if (!arc) {
      arc = {
        wahlap_id: r.wahlap_id,
        name: r.name,
        address: r.address,
        country: 'China',
        country_code: COUNTRY_CODE,
        province_zh: r.province_zh,
        province: r.province,
        centroid: r.centroid,
        placeIds: new Set(),
        games: new Set(),
      };
      byId.set(r.wahlap_id, arc);
    }
    arc.games.add(r.variant);
    if (r.placeId) arc.placeIds.add(r.placeId);
  }
  return [...byId.values()];
}

function toArcade(merged) {
  // Canonical id: smallest placeId, offset by +1,000,000 to avoid collisions
  // with SEGA sids (which top out around 25,000). All ids stay numeric.
  const placeIdsAsInts = [...merged.placeIds]
    .map(p => parseInt(p, 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  const id = placeIdsAsInts.length ? 1_000_000 + placeIdsAsInts[0] : null;
  const games = [...merged.games].sort();
  const detail_urls = {};
  for (const g of games) detail_urls[g] = PAGE_URLS[g];

  return {
    id,
    name: merged.name,
    address: merged.address,
    country: merged.country,
    country_code: merged.country_code,
    prefecture: merged.province,         // reuse the existing 'prefecture' field for the sub-region (Japan: prefecture, China: province)
    lat: merged.centroid[0],
    lon: merged.centroid[1],
    games,
    detail_urls,
    geocoding: {
      source: 'province_centroid',
      is_approximate: true,
      province_zh: merged.province_zh,
    },
  };
}

function summarizeProvinces(arcades) {
  const m = new Map();
  for (const a of arcades) {
    if (a.country_code !== COUNTRY_CODE || !a.prefecture) continue;
    const existing = m.get(a.prefecture) ?? { name: a.prefecture, count: 0 };
    existing.count += 1;
    m.set(a.prefecture, existing);
  }
  return [...m.values()].sort((x, y) => x.name.localeCompare(y.name));
}

async function main() {
  console.log('Fetching Wahlap endpoints…');
  const raw = [];
  const perVariant = {};
  for (const e of ENDPOINTS) {
    const data = await fetchEndpoint(e.url);
    if (!Array.isArray(data)) throw new Error(`Unexpected payload at ${e.url}: ${JSON.stringify(data).slice(0, 200)}`);
    perVariant[e.variant] = data.length;
    console.log(`  ${e.variant.padEnd(14)} → ${data.length} entries`);
    raw.push(...buildRawEntries(data, e.variant));
  }

  const merged = mergeRaw(raw);
  const arcades = merged.map(toArcade);
  console.log(`\nMerged: ${arcades.length} unique China arcades`);
  console.log(`  with both games:    ${arcades.filter(a => a.games.length === 2).length}`);
  console.log(`  maimai_cn only:     ${arcades.filter(a => a.games.length === 1 && a.games[0] === 'maimai_cn').length}`);
  console.log(`  chunithm_cn only:   ${arcades.filter(a => a.games.length === 1 && a.games[0] === 'chunithm_cn').length}`);

  // Merge into arcades.json: replace any existing China entries (idempotent),
  // keep everything else as-is.
  if (!existsSync(ARCADES_FILE)) {
    throw new Error(`arcades.json not found at ${ARCADES_FILE}. Run scrape.mjs first.`);
  }
  const existing = JSON.parse(await readFile(ARCADES_FILE, 'utf8'));
  const nonChina = (existing.arcades ?? []).filter(a => a.country_code !== COUNTRY_CODE);
  const combined = [...nonChina, ...arcades].sort((a, b) => {
    if (a.country !== b.country) return a.country.localeCompare(b.country);
    const ap = a.prefecture ?? '';
    const bp = b.prefecture ?? '';
    if (ap !== bp) return ap.localeCompare(bp);
    return a.name.localeCompare(b.name);
  });

  // Refresh countries summary.
  const countryCounts = new Map();
  for (const a of combined) {
    const e = countryCounts.get(a.country_code) ?? { code: a.country_code, name: a.country, count: 0 };
    e.count += 1;
    countryCounts.set(a.country_code, e);
  }
  const countries = [...countryCounts.values()].sort((x, y) => x.name.localeCompare(y.name));
  const provinces = summarizeProvinces(combined);

  // Sources block — keep the existing Japan/intl URLs and add Wahlap.
  const source_urls = {
    ...(existing.source_urls ?? {}),
    maimai_cn:   PAGE_URLS.maimai_cn,
    chunithm_cn: PAGE_URLS.chunithm_cn,
  };

  const out = {
    ...existing,
    source_urls,
    cn_scraped_at: new Date().toISOString(),
    countries,
    prefectures: existing.prefectures ?? [],
    provinces,
    arcades: combined,
  };

  await writeFile(ARCADES_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${combined.length} total arcades to arcades.json`);
  console.log(`  countries:  ${countries.length}`);
  console.log(`  provinces:  ${provinces.length}`);
  console.log(`  China:      ${countryCounts.get(COUNTRY_CODE)?.count ?? 0}`);
}

await main();
