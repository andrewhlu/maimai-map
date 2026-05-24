// Scrapes SEGA's official arcade locator for maimai DX, CHUNITHM, and Ongeki
// (Japan + International). Writes arcades.json next to this file.
//
// Usage: node scrape.mjs
// Requires: Node.js >= 18 (for global fetch).

import { writeFile } from 'node:fs/promises';

const BASE = 'https://location.am-all.net/alm/location';
const UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const POLITENESS_MS = 400;

const LOCATORS = [
  { variant: 'maimai',        scope: 'japan', gm: 96,  label: 'maimai DX (Japan)'        },
  { variant: 'maimai_intl',   scope: 'intl',  gm: 98,  label: 'maimai DX International'  },
  { variant: 'chunithm',      scope: 'japan', gm: 109, label: 'CHUNITHM (Japan)'         },
  { variant: 'chunithm_intl', scope: 'intl',  gm: 104, label: 'CHUNITHM International'   },
  { variant: 'ongeki',        scope: 'japan', gm: 88,  label: 'Ongeki'                   },
];

const INTL_COUNTRIES = [
  { ct: 1001, name: 'Taiwan'         },
  { ct: 1002, name: 'Hong Kong'      },
  { ct: 1003, name: 'Singapore'      },
  { ct: 1004, name: 'Malaysia'       },
  { ct: 1005, name: 'Korea'          },
  { ct: 1006, name: 'Thailand'       },
  { ct: 1007, name: 'Indonesia'      },
  { ct: 1008, name: 'Macau'          },
  { ct: 1009, name: 'North America'  },
  { ct: 1010, name: 'Philippines'    },
  { ct: 1011, name: 'Viet Nam'       },
  { ct: 1012, name: 'Australia'      },
  { ct: 1013, name: 'Myanmar'        },
  { ct: 1014, name: 'New Zealand'    },
];

const INTL_DISABLED = { chunithm_intl: new Set([1009]) };

const JP_PREFECTURES = [
  { at: 0,  name: 'Hokkaido'  }, { at: 1,  name: 'Aomori'   }, { at: 2,  name: 'Iwate'    },
  { at: 3,  name: 'Miyagi'    }, { at: 4,  name: 'Akita'    }, { at: 5,  name: 'Yamagata' },
  { at: 6,  name: 'Fukushima' }, { at: 7,  name: 'Ibaraki'  }, { at: 8,  name: 'Tochigi'  },
  { at: 9,  name: 'Gunma'     }, { at: 10, name: 'Saitama'  }, { at: 11, name: 'Chiba'    },
  { at: 12, name: 'Tokyo'     }, { at: 13, name: 'Kanagawa' }, { at: 14, name: 'Niigata'  },
  { at: 15, name: 'Toyama'    }, { at: 16, name: 'Ishikawa' }, { at: 17, name: 'Fukui'    },
  { at: 18, name: 'Yamanashi' }, { at: 19, name: 'Nagano'   }, { at: 20, name: 'Gifu'     },
  { at: 21, name: 'Shizuoka'  }, { at: 22, name: 'Aichi'    }, { at: 23, name: 'Mie'      },
  { at: 24, name: 'Shiga'     }, { at: 25, name: 'Kyoto'    }, { at: 26, name: 'Osaka'    },
  { at: 27, name: 'Hyogo'     }, { at: 28, name: 'Nara'     }, { at: 29, name: 'Wakayama' },
  { at: 30, name: 'Tottori'   }, { at: 31, name: 'Shimane'  }, { at: 32, name: 'Okayama'  },
  { at: 33, name: 'Hiroshima' }, { at: 34, name: 'Yamaguchi'}, { at: 35, name: 'Tokushima'},
  { at: 36, name: 'Kagawa'    }, { at: 37, name: 'Ehime'    }, { at: 38, name: 'Kochi'    },
  { at: 39, name: 'Fukuoka'   }, { at: 40, name: 'Saga'     }, { at: 41, name: 'Nagasaki' },
  { at: 42, name: 'Kumamoto'  }, { at: 43, name: 'Oita'     }, { at: 44, name: 'Miyazaki' },
  { at: 45, name: 'Kagoshima' }, { at: 46, name: 'Okinawa'  },
];

// Manually-curated denylist of (variant, sid) pairs to drop. Use this for
// upstream entries that have wrong coordinates or are otherwise broken in
// SEGA's locator. Each entry should explain *why* it's denied.
const DENYLIST = new Set([
  // QUANTUM SM PAMPANGA — SEGA geocoded the address against San Jose, CA
  // instead of San Jose del Monte, Pampanga (Philippines). Remove until
  // the upstream listing is fixed.
  'maimai_intl:18702',
]);

const SHOP_RE = /<span class="store_name">([^<]+)<\/span>\s*<span class="store_address">([^<]+)<\/span>[\s\S]*?@(-?\d+\.\d+),(-?\d+\.\d+)[\s\S]*?location\.href='shop\?([^']+)'/g;

function extractSid(query) {
  const m = query.match(/sid=(\d+)/);
  return m ? m[1] : null;
}

function htmlUnescape(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function nameKey(s) {
  return s.toUpperCase().replace(/[\s\p{P}]+/gu, '');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchListing(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseShops(html, ctx) {
  const out = [];
  for (const m of html.matchAll(SHOP_RE)) {
    const [, rawName, rawAddr, latStr, lonStr, queryStr] = m;
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error(`NaN coords for "${rawName}" at ${ctx.url}`);
    }
    const name = cleanWhitespace(htmlUnescape(rawName));
    const address = cleanWhitespace(htmlUnescape(rawAddr));
    const sid = extractSid(htmlUnescape(queryStr));
    if (sid && DENYLIST.has(`${ctx.variant}:${sid}`)) continue;
    const detail_url = `https://location.am-all.net/alm/shop?${htmlUnescape(queryStr)}`;
    out.push({
      variant: ctx.variant,
      gm: ctx.gm,
      country: ctx.country,
      country_code: ctx.country_code,
      prefecture: ctx.prefecture,
      prefecture_at: ctx.prefecture_at,
      name,
      address,
      lat,
      lon,
      detail_url,
    });
  }
  return out;
}

function buildRequests() {
  const reqs = [];
  for (const loc of LOCATORS) {
    if (loc.scope === 'intl') {
      const disabled = INTL_DISABLED[loc.variant] ?? new Set();
      for (const c of INTL_COUNTRIES) {
        if (disabled.has(c.ct)) continue;
        reqs.push({
          variant: loc.variant,
          gm: loc.gm,
          url: `${BASE}?gm=${loc.gm}&lang=en&ct=${c.ct}`,
          country: c.name,
          country_code: c.ct,
          prefecture: null,
          prefecture_at: null,
        });
      }
    } else {
      for (const p of JP_PREFECTURES) {
        reqs.push({
          variant: loc.variant,
          gm: loc.gm,
          url: `${BASE}?gm=${loc.gm}&lang=en&ct=1000&at=${p.at}`,
          country: 'Japan',
          country_code: 1000,
          prefecture: p.name,
          prefecture_at: p.at,
        });
      }
    }
  }
  return reqs;
}

function pickName(a, b) {
  // Prefer the longer / non-empty spelling.
  if (!b) return a;
  if (!a) return b;
  return a.length >= b.length ? a : b;
}

function pickAddress(a, b) {
  if (!b) return a;
  if (!a) return b;
  return a.length >= b.length ? a : b;
}

function mergeRaw(rawEntries) {
  const byCoord = new Map();
  const byName  = new Map();

  for (const r of rawEntries) {
    const coordKey = `${r.country_code}:${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    const nameK    = `${r.country_code}:${nameKey(r.name)}`;

    let arc = byCoord.get(coordKey) ?? byName.get(nameK);
    if (!arc) {
      arc = {
        name: r.name,
        address: r.address,
        country: r.country,
        country_code: r.country_code,
        prefecture: r.prefecture,
        lat: r.lat,
        lon: r.lon,
        games: new Set(),
        detail_urls: {},
      };
      byCoord.set(coordKey, arc);
      byName.set(nameK, arc);
    } else {
      // Index this arc under both keys so future lookups hit either.
      byCoord.set(coordKey, arc);
      byName.set(nameK, arc);
      arc.name = pickName(arc.name, r.name);
      arc.address = pickAddress(arc.address, r.address);
      if (r.prefecture && !arc.prefecture) arc.prefecture = r.prefecture;
    }
    arc.games.add(r.variant);
    arc.detail_urls[r.variant] = r.detail_url;
  }

  // Dedupe to the unique set of arc objects.
  const uniq = new Set([...byCoord.values()]);
  return [...uniq].map(a => {
    // Pick the smallest sid across all variants as the canonical id.
    // Most arcades agree across variants; the few that don't (e.g. when
    // SEGA assigned separate listings per game) get a deterministic pick.
    const sids = Object.values(a.detail_urls)
      .map(u => u.match(/sid=(\d+)/)?.[1])
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .sort((x, y) => x - y);
    return {
      id: sids[0] ?? null,
      name: a.name,
      address: a.address,
      country: a.country,
      country_code: a.country_code,
      prefecture: a.prefecture,
      lat: a.lat,
      lon: a.lon,
      games: [...a.games].sort(),
      detail_urls: a.detail_urls,
    };
  });
}

function summarize(arcades, raw) {
  const countries = new Map();
  const prefectures = new Map();
  const variantCounts = {};
  const sizeHistogram = {};

  for (const a of arcades) {
    countries.set(a.country_code, {
      code: a.country_code,
      name: a.country,
      count: (countries.get(a.country_code)?.count ?? 0) + 1,
    });
    if (a.prefecture) {
      const key = a.prefecture;
      const existing = prefectures.get(key) ?? {
        at: JP_PREFECTURES.find(p => p.name === a.prefecture)?.at ?? -1,
        name: a.prefecture,
        count: 0,
      };
      existing.count += 1;
      prefectures.set(key, existing);
    }
    sizeHistogram[a.games.length] = (sizeHistogram[a.games.length] ?? 0) + 1;
  }
  for (const r of raw) {
    variantCounts[r.variant] = (variantCounts[r.variant] ?? 0) + 1;
  }

  const countriesList   = [...countries.values()].sort((x, y) => x.name.localeCompare(y.name));
  const prefecturesList = [...prefectures.values()].sort((x, y) => x.at - y.at);

  return { countries: countriesList, prefectures: prefecturesList, variantCounts, sizeHistogram };
}

async function main() {
  const reqs = buildRequests();
  console.log(`Fetching ${reqs.length} listings…`);

  const raw = [];
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i];
    let html;
    try {
      html = await fetchListing(r.url);
    } catch (e) {
      console.error(`  ✖ ${r.url}: ${e.message}`);
      await sleep(POLITENESS_MS);
      continue;
    }
    const shops = parseShops(html, r);
    raw.push(...shops);
    const tag = r.scope === 'intl' || r.country !== 'Japan'
      ? `gm=${r.gm} ct=${r.country_code} (${r.country})`
      : `gm=${r.gm} at=${r.prefecture_at} (${r.prefecture})`;
    console.log(`  [${String(i + 1).padStart(3)}/${reqs.length}] ${r.variant.padEnd(14)} ${tag.padEnd(40)} → ${shops.length} shops`);
    await sleep(POLITENESS_MS);
  }

  console.log(`\nRaw entries: ${raw.length}`);
  const arcades = mergeRaw(raw);
  arcades.sort((a, b) => {
    if (a.country !== b.country) return a.country.localeCompare(b.country);
    const ap = a.prefecture ?? '';
    const bp = b.prefecture ?? '';
    if (ap !== bp) return ap.localeCompare(bp);
    return a.name.localeCompare(b.name);
  });

  const { countries, prefectures, variantCounts, sizeHistogram } = summarize(arcades, raw);

  console.log(`Unique arcades: ${arcades.length}`);
  console.log('Per variant (raw counts):');
  for (const [v, n] of Object.entries(variantCounts)) console.log(`  ${v.padEnd(14)} ${n}`);
  console.log('Per country:');
  for (const c of countries) console.log(`  ${c.name.padEnd(20)} ${c.count}`);
  console.log('Variants per arcade:');
  for (const [k, n] of Object.entries(sizeHistogram).sort()) console.log(`  ${k} variant(s): ${n}`);

  const out = {
    source_urls: {
      maimai:        `${BASE}?gm=96&lang=en`,
      maimai_intl:   `${BASE}?gm=98&lang=en`,
      chunithm:      `${BASE}?gm=109&lang=en`,
      chunithm_intl: `${BASE}?gm=104&lang=en`,
      ongeki:        `${BASE}?gm=88&lang=en`,
    },
    scraped_at: new Date().toISOString(),
    countries,
    prefectures,
    arcades,
  };

  await writeFile(new URL('./arcades.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${arcades.length} arcades to arcades.json`);
}

await main();
