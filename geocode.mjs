// Geocodes arcades.json against OpenStreetMap's Nominatim API and writes
// arcades.geocoded.json with corrected lat/lon. Falls back to SEGA's original
// coordinates if Nominatim returns nothing or a result in the wrong country.
//
// Usage:
//   node geocode.mjs                      # geocode every arcade missing from cache
//   node geocode.mjs --limit 20           # only process the first 20 (sanity test)
//   node geocode.mjs --force              # ignore cache, re-query everything
//   node geocode.mjs --country Malaysia   # only arcades in this country (case-insensitive)
//
// Cache: writes geocode.cache.json keyed by `country_code|name|address`. Reruns
// pull from the cache so retries / partial runs are cheap.
//
// Nominatim usage policy: <https://operations.osmfoundation.org/policies/nominatim/>
//   - Maximum 1 request per second.
//   - A meaningful User-Agent identifying the application is required.
//   - For larger-scale needs, run a self-hosted Nominatim instance.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'sega-arcade-map-builder/1.0 (https://github.com/local; personal project)';
const RATE_MS = 1100; // 1 req/sec + slack
const CACHE_FILE = new URL('./geocode.cache.json', import.meta.url);
const GOOGLE_CACHE_FILE = new URL('./google.cache.json', import.meta.url);
const INPUT_FILE = new URL('./arcades.json', import.meta.url);
const OUTPUT_FILE = new URL('./arcades.geocoded.json', import.meta.url);

// ISO 3166-1 alpha-2 codes used to sanity-check Nominatim results.
// If Nominatim returns a result with `address.country_code` that doesn't
// match here, we treat it as a miss and fall back to SEGA's coords.
const EXPECTED_CC = {
  1000: 'jp',  // Japan
  1001: 'tw',  // Taiwan
  1002: 'hk',  // Hong Kong
  1003: 'sg',  // Singapore
  1004: 'my',  // Malaysia
  1005: 'kr',  // Korea
  1006: 'th',  // Thailand
  1007: 'id',  // Indonesia
  1008: 'mo',  // Macau
  1009: 'us',  // North America (treat as US — Nominatim returns 'us' for the entries we have)
  1010: 'ph',  // Philippines
  1011: 'vn',  // Viet Nam
  1012: 'au',  // Australia
  1013: 'mm',  // Myanmar
  1014: 'nz',  // New Zealand
  1100: 'cn',  // China (Wahlap)
};

function parseArgs(argv) {
  const out = { limit: null, force: false, country: null, cnOnly: false, noCn: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--force') out.force = true;
    else if (a === '--country') out.country = argv[++i].toLowerCase();
    else if (a === '--cn-only') out.cnOnly = true;
    else if (a === '--no-cn') out.noCn = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (out.cnOnly && out.noCn) throw new Error('--cn-only and --no-cn are mutually exclusive');
  return out;
}

async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn(`Cache file unreadable, starting fresh: ${e.message}`);
    return {};
  }
}

async function saveCache(cache) {
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cacheKey(a) {
  return `${a.country_code}|${a.name}|${a.address}`;
}

// Try the most specific query first ("name, address, country") and fall
// back to less specific ones. We return the first hit whose country code
// matches what we expect.
function buildQueries(a) {
  const queries = [];
  if (a.name && a.address) queries.push(`${a.name}, ${a.address}, ${a.country}`);
  if (a.name) queries.push(`${a.name}, ${a.country}`);
  if (a.address) queries.push(`${a.address}, ${a.country}`);
  return queries;
}

async function nominatim(query, country_code) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '5',
  });
  // Constrain to expected country when we have one, to drastically improve
  // hit quality (especially for ambiguous mall names).
  const cc = EXPECTED_CC[country_code];
  if (cc) params.set('countrycodes', cc);

  const res = await fetch(`${NOMINATIM}?${params}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  if (res.status === 429) throw new Error('Rate limited (HTTP 429) — slow down');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function geocodeOne(arcade) {
  const expected = EXPECTED_CC[arcade.country_code];
  for (const q of buildQueries(arcade)) {
    const hits = await nominatim(q, arcade.country_code);
    await sleep(RATE_MS);
    if (!hits.length) continue;

    // Prefer hits whose address.country_code matches.
    const goodHits = expected
      ? hits.filter(h => h.address?.country_code === expected)
      : hits;
    const pick = goodHits[0] ?? null;
    if (pick) {
      return {
        lat: parseFloat(pick.lat),
        lon: parseFloat(pick.lon),
        display_name: pick.display_name,
        osm_type: pick.osm_type,
        osm_id: pick.osm_id,
        match_query: q,
        match_class: pick.class,
        match_type: pick.type,
        importance: pick.importance,
      };
    }
    // No country-matching hit — try next, less specific query.
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const segaData = JSON.parse(await readFile(INPUT_FILE, 'utf8'));
  const cache = args.force ? {} : await loadCache();

  // Skip Japan: SEGA's official Japan listings already include accurate
  // coordinates, and Nominatim's Japanese-address coverage is generally
  // worse than what SEGA provides — geocoding them tends to make the data
  // worse, not better. Always trust the SEGA originals for Japan.
  let candidates = segaData.arcades.filter(a => a.country_code !== 1000);
  console.log(`Skipping ${segaData.arcades.length - candidates.length} Japan arcades (always using SEGA-official coords)`);
  if (args.cnOnly) {
    candidates = candidates.filter(a => a.country_code === 1100);
    console.log(`--cn-only: ${candidates.length} China arcades`);
  } else if (args.noCn) {
    candidates = candidates.filter(a => a.country_code !== 1100);
    console.log(`--no-cn: ${candidates.length} non-China arcades`);
  }
  if (args.country) {
    candidates = candidates.filter(a => a.country.toLowerCase() === args.country);
    console.log(`Filtered to country "${args.country}": ${candidates.length} arcades`);
  }
  if (args.limit !== null) {
    candidates = candidates.slice(0, args.limit);
    console.log(`Limited to first ${candidates.length} arcades`);
  }

  const todo = candidates.filter(a => !cache[cacheKey(a)]);
  console.log(`${candidates.length} candidates · ${candidates.length - todo.length} cached · ${todo.length} to geocode`);
  if (todo.length) {
    const eta = Math.round((todo.length * RATE_MS * 1.5) / 1000); // ~1.5 queries/arcade avg
    console.log(`ETA: ~${Math.floor(eta / 60)}m ${eta % 60}s at 1 req/s`);
  }

  let i = 0;
  for (const a of todo) {
    i++;
    try {
      const result = await geocodeOne(a);
      cache[cacheKey(a)] = { result, geocoded_at: new Date().toISOString() };
      const tag = result
        ? `→ (${result.lat.toFixed(5)}, ${result.lon.toFixed(5)}) ${result.match_type}`
        : '→ no match';
      console.log(`  [${String(i).padStart(4)}/${todo.length}] ${a.country.padEnd(14)} ${a.name.slice(0, 40).padEnd(40)} ${tag}`);
    } catch (e) {
      console.error(`  [${i}/${todo.length}] ${a.name}: ${e.message}`);
      // Save what we have so far so a Ctrl-C doesn't lose progress.
      await saveCache(cache);
      throw e;
    }
    // Periodic flush every 25 entries to limit data loss on crash.
    if (i % 25 === 0) await saveCache(cache);
  }
  await saveCache(cache);

  // Build the geocoded arcades.json. For each arcade in the *full* dataset
  // (not just `candidates`), use the cached result if present and good,
  // otherwise fall back to SEGA's coords. This way a partial run produces a
  // valid output file with whatever we've geocoded so far.
  // Also pull in Google Places results (from geocode-google.mjs) when
  // Nominatim came back empty.
  const googleCache = existsSync(GOOGLE_CACHE_FILE)
    ? JSON.parse(await readFile(GOOGLE_CACHE_FILE, 'utf8'))
    : {};
  let nomCount = 0, googleCount = 0, missing = 0, originalCount = 0;
  const out = segaData.arcades.map(a => {
    // Japan is intentionally skipped — SEGA's official coords are already
    // good and we don't query geocoders for them. Tag immediately and bail
    // before any cache lookup, so stale cache entries from earlier runs
    // (when Japan wasn't skipped) don't override the canonical tag.
    if (a.country_code === 1000) {
      originalCount++;
      return { ...a, geocoding: { source: 'sega_official_japan' } };
    }

    const k = cacheKey(a);
    const nom = cache[k]?.result;
    const goog = googleCache[k]?.result;

    if (nom) {
      nomCount++;
      return {
        ...a,
        lat: nom.lat,
        lon: nom.lon,
        geocoding: {
          source: 'nominatim',
          display_name: nom.display_name,
          osm_type: nom.osm_type,
          osm_id: nom.osm_id,
          match_query: nom.match_query,
          match_class: nom.match_class,
          match_type: nom.match_type,
          original_lat: a.lat,
          original_lon: a.lon,
        },
      };
    }
    if (goog) {
      googleCount++;
      return {
        ...a,
        lat: goog.lat,
        lon: goog.lon,
        geocoding: {
          source: 'google_places',
          place_id: goog.place_id,
          display_name: goog.display_name,
          types: goog.types,
          primary_type: goog.primary_type,
          match_query: goog.match_query,
          original_lat: a.lat,
          original_lon: a.lon,
        },
      };
    }
    if (cache[k] && cache[k].result === null) {
      missing++;
      const reason = googleCache[k] && googleCache[k].result === null ? 'no_match' : 'no_match_nominatim';
      // For China entries, falling back means keeping the province centroid
      // that scrape-cn.mjs already populated. Tag it as approximate so the
      // popup can show a warning. Other countries fall back to SEGA's coords.
      if (a.country_code === 1100) {
        return {
          ...a,
          geocoding: {
            source: 'province_centroid',
            is_approximate: true,
            reason,
            province_zh: a.geocoding?.province_zh,
          },
        };
      }
      return { ...a, geocoding: { source: 'sega_fallback', reason } };
    }
    originalCount++;
    return { ...a, geocoding: { source: 'sega_original' } };
  });

  const outFile = {
    ...segaData,
    geocoded_at: new Date().toISOString(),
    geocoder: {
      provider: googleCount > 0 ? 'nominatim+google_places' : 'nominatim',
      endpoint: NOMINATIM,
      coverage: {
        nominatim: nomCount,
        google_places: googleCount,
        no_match_fallback: missing,
        not_yet_geocoded: originalCount,
        total: segaData.arcades.length,
      },
    },
    arcades: out,
  };
  await writeFile(OUTPUT_FILE, JSON.stringify(outFile, null, 2));
  console.log(`\nWrote ${out.length} arcades to arcades.geocoded.json`);
  console.log(`  via Nominatim:      ${nomCount}`);
  console.log(`  via Google Places:  ${googleCount}`);
  console.log(`  no-match fallback:  ${missing}`);
  console.log(`  not-yet-geocoded:   ${originalCount} (will be geocoded on next run)`);
}

await main();
