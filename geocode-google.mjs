// Geocodes arcades that Nominatim couldn't find, using Google's Places API
// (New) — Text Search endpoint. Requires a Google Maps Platform API key in
// the GOOGLE_MAPS_API_KEY environment variable. See README for setup.
//
// Usage:
//   GOOGLE_MAPS_API_KEY=AIza... node geocode-google.mjs
//   GOOGLE_MAPS_API_KEY=AIza... node geocode-google.mjs --limit 20
//   GOOGLE_MAPS_API_KEY=AIza... node geocode-google.mjs --country malaysia
//   GOOGLE_MAPS_API_KEY=AIza... node geocode-google.mjs --force          # ignore google cache
//   GOOGLE_MAPS_API_KEY=AIza... node geocode-google.mjs --include-misses # also retry already-cached "no match" entries
//
// Reads:
//   arcades.json            — source of truth
//   geocode.cache.json      — written by geocode.mjs; only Nominatim no-match entries are processed
//   google.cache.json       — this script's own cache
//
// Writes:
//   google.cache.json       — append/update results
//   arcades.geocoded.json   — merged output (Nominatim wins, then Google, then SEGA fallback)
//
// Pricing note: Places API (New) Text Search costs ~$0.032 per call (subject
// to change). Google Maps Platform offers a recurring $200/month free credit,
// which covers ~6,250 calls per month — more than enough for our use case.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

// Minimal .env loader — picks up `KEY=VALUE` lines from a `.env` file next to
// this script. Real env vars take precedence so `GOOGLE_MAPS_API_KEY=… node …`
// still works as expected. Unquoted/quoted values are both supported.
function loadDotenv() {
  const path = new URL('./.env', import.meta.url);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;  // real env wins
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotenv();

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType';
const RATE_MS = 200;  // 5 req/sec — well below Google's 100 QPS default.
const INPUT_FILE = new URL('./arcades.json', import.meta.url);
const NOMINATIM_CACHE = new URL('./geocode.cache.json', import.meta.url);
const GOOGLE_CACHE = new URL('./google.cache.json', import.meta.url);
const OUTPUT_FILE = new URL('./arcades.geocoded.json', import.meta.url);

// ISO 3166-1 alpha-2 codes to constrain Google results.
const REGION_CODES = {
  1000: 'jp', 1001: 'tw', 1002: 'hk', 1003: 'sg', 1004: 'my', 1005: 'kr',
  1006: 'th', 1007: 'id', 1008: 'mo', 1009: 'us', 1010: 'ph', 1011: 'vn',
  1012: 'au', 1013: 'mm', 1014: 'nz', 1100: 'cn',
};

function parseArgs(argv) {
  const out = { limit: null, force: false, country: null, includeMisses: false, all: false, yes: false, cnOnly: false, noCn: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--force') out.force = true;
    else if (a === '--country') out.country = argv[++i].toLowerCase();
    else if (a === '--include-misses') out.includeMisses = true;
    else if (a === '--all') out.all = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--cn-only') out.cnOnly = true;
    else if (a === '--no-cn') out.noCn = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (out.cnOnly && out.noCn) throw new Error('--cn-only and --no-cn are mutually exclusive');
  return out;
}

// Places API (New) Text Search SKU pricing as of 2026-05.
// Update if Google's pricing changes — see the README "Pricing model" link.
const COST_PER_CALL_USD = 0.032;
const FREE_CREDIT_USD = 200; // monthly recurring credit

function estimateCost(numCalls) {
  const gross = numCalls * COST_PER_CALL_USD;
  const afterCredit = Math.max(0, gross - FREE_CREDIT_USD);
  return { gross, afterCredit };
}

async function loadJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    console.warn(`Couldn't read ${path}: ${e.message}`);
    return fallback;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cacheKey(a) {
  return `${a.country_code}|${a.name}|${a.address}`;
}

async function placesTextSearch(textQuery, country_code) {
  const region = REGION_CODES[country_code];
  const body = {
    textQuery,
    languageCode: 'en',
    pageSize: 5,
  };
  // `regionCode` is the singular two-letter CLDR code that biases ranking
  // and address formatting toward a region. (NB: this is different from
  // `includedRegionCodes`, which exists on Place Search but not Text Search.)
  if (region) body.regionCode = region;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('Rate limited (HTTP 429) — slow down');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.places ?? [];
}

async function geocodeOne(arcade) {
  const queries = [];
  if (arcade.name && arcade.address) queries.push(`${arcade.name} ${arcade.address}`);
  if (arcade.name) queries.push(arcade.name);
  if (arcade.address) queries.push(arcade.address);

  for (const q of queries) {
    const places = await placesTextSearch(q, arcade.country_code);
    await sleep(RATE_MS);
    if (!places.length) continue;
    const pick = places[0];
    if (!pick.location) continue;
    return {
      lat: pick.location.latitude,
      lon: pick.location.longitude,
      place_id: pick.id,
      display_name: pick.formattedAddress ?? pick.displayName?.text ?? '',
      types: pick.types ?? [],
      primary_type: pick.primaryType ?? null,
      match_query: q,
    };
  }
  return null;
}

function makeGoogleEntry(a, goog) {
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

function makeNominatimEntry(a, nom) {
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

function mergeAndWrite(segaData, nomCache, googleCache, { googleFirst }) {
  let nomCount = 0, googleCount = 0, fallbackCount = 0, originalCount = 0;
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
    const nom = nomCache[k]?.result;
    const goog = googleCache[k]?.result;

    // In --all mode, prefer Google over Nominatim. Otherwise keep Nominatim
    // as primary and use Google only as a fallback.
    if (googleFirst && goog) {
      googleCount++;
      return makeGoogleEntry(a, goog);
    }
    if (nom) {
      nomCount++;
      return makeNominatimEntry(a, nom);
    }
    if (goog) {
      googleCount++;
      return makeGoogleEntry(a, goog);
    }
    // Helper: build the appropriate fallback entry for an arcade where one
    // or both providers came up empty. China keeps its province centroid
    // (set by scrape-cn.mjs) and is tagged approximate; everywhere else
    // falls back to SEGA's original coords.
    const fallback = reason => {
      fallbackCount++;
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
    };

    if (nomCache[k] && nomCache[k].result === null && googleCache[k] && googleCache[k].result === null) {
      return fallback('no_match');
    }
    if (nomCache[k] && nomCache[k].result === null) {
      return fallback('no_match_nominatim');
    }
    if (googleCache[k] && googleCache[k].result === null) {
      return fallback('no_match_google');
    }
    originalCount++;
    return { ...a, geocoding: { source: 'sega_original' } };
  });

  return {
    file: {
      ...segaData,
      geocoded_at: new Date().toISOString(),
      geocoder: {
        provider: googleFirst
          ? 'google_places'
          : (googleCount > 0 ? 'nominatim+google_places' : 'nominatim'),
        coverage: {
          nominatim: nomCount,
          google_places: googleCount,
          no_match_fallback: fallbackCount,
          not_yet_geocoded: originalCount,
          total: segaData.arcades.length,
        },
      },
      arcades: out,
    },
    counts: { nomCount, googleCount, fallbackCount, originalCount },
  };
}

async function main() {
  if (!API_KEY) {
    console.error('Missing GOOGLE_MAPS_API_KEY environment variable. See README "Geocode (Google Places fallback)" for setup.');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  const segaData = JSON.parse(await readFile(INPUT_FILE, 'utf8'));
  const nomCache = await loadJson(NOMINATIM_CACHE, {});
  const googleCache = args.force ? {} : await loadJson(GOOGLE_CACHE, {});

  // Skip Japan: SEGA's official Japan listings already include accurate
  // coordinates. Re-geocoding via Google adds cost and tends to *worsen*
  // accuracy for malls/arcades inside complex buildings. Always trust the
  // SEGA originals for Japan.
  const eligible = segaData.arcades.filter(a => a.country_code !== 1000);
  const skipped = segaData.arcades.length - eligible.length;
  if (skipped > 0) console.log(`Skipping ${skipped} Japan arcades (always using SEGA-official coords)`);

  // Candidate selection:
  //   default → only arcades where Nominatim returned a definitive null
  //   --all   → every arcade (Google becomes the primary source)
  let candidates = args.all
    ? eligible.slice()
    : eligible.filter(a => {
        const c = nomCache[cacheKey(a)];
        return c && c.result === null;
      });
  if (args.cnOnly) {
    candidates = candidates.filter(a => a.country_code === 1100);
    console.log(`--cn-only: ${candidates.length} China arcades`);
  } else if (args.noCn) {
    candidates = candidates.filter(a => a.country_code !== 1100);
    console.log(`--no-cn: ${candidates.length} non-China arcades`);
  }
  if (args.country) {
    candidates = candidates.filter(a => a.country.toLowerCase() === args.country);
  }
  if (args.limit !== null) {
    candidates = candidates.slice(0, args.limit);
  }

  const todo = candidates.filter(a => {
    const cached = googleCache[cacheKey(a)];
    if (!cached) return true;
    if (cached.result === null && args.includeMisses) return true;
    return false;
  });

  // Each arcade may need up to 3 queries (name+address → name → address)
  // before we get a hit, so worst-case calls = 3× todo. Average is closer
  // to 1.2× because most queries hit on the first attempt. Estimate the
  // worst case for cost (better to overestimate cost up front).
  const worstCaseCalls = todo.length * 3;
  const expectedCalls = Math.round(todo.length * 1.2);

  if (args.all) {
    console.log(`Mode: --all (every arcade goes through Google Places)`);
  } else {
    console.log(`Mode: Nominatim no-match fill-in (default)`);
  }
  console.log(`  candidates:               ${candidates.length}`);
  console.log(`  already cached in google: ${candidates.length - todo.length}`);
  console.log(`  to query Google:          ${todo.length}`);
  if (todo.length) {
    const eta = Math.round((expectedCalls * RATE_MS) / 1000);
    const costExpected = estimateCost(expectedCalls);
    const costWorst = estimateCost(worstCaseCalls);
    console.log(`  ETA:                      ~${Math.floor(eta / 60)}m ${eta % 60}s at ${1000 / RATE_MS} req/s`);
    console.log(`  Est. API calls:           ~${expectedCalls} expected · up to ${worstCaseCalls} worst case`);
    console.log(`  Est. cost (Text Search):  $${costExpected.gross.toFixed(2)} expected · $${costWorst.gross.toFixed(2)} worst case`);
    console.log(`  After $${FREE_CREDIT_USD}/mo free credit:  $${costExpected.afterCredit.toFixed(2)} expected · $${costWorst.afterCredit.toFixed(2)} worst case`);
  }

  // Confirm before spending money on a large run, unless the user passed
  // --yes or set up CI / scripted invocation. Threshold of 100 calls is
  // ~$3.20 worst case — small enough not to nag, large enough to catch
  // accidental "node geocode-google.mjs --all" runs.
  if (todo.length > 100 && !args.yes) {
    const expectedCost = estimateCost(expectedCalls).gross.toFixed(2);
    process.stdout.write(`\nProceed with ~$${expectedCost} of API calls? [y/N] `);
    const answer = await new Promise(resolve => {
      process.stdin.once('data', d => resolve(d.toString().trim().toLowerCase()));
      process.stdin.resume();
    });
    process.stdin.pause();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted. Pass --yes to skip this prompt.');
      process.exit(0);
    }
  }

  let i = 0;
  for (const a of todo) {
    i++;
    try {
      const result = await geocodeOne(a);
      googleCache[cacheKey(a)] = { result, geocoded_at: new Date().toISOString() };
      const tag = result
        ? `→ (${result.lat.toFixed(5)}, ${result.lon.toFixed(5)}) ${result.primary_type ?? '—'}`
        : '→ no match';
      console.log(`  [${String(i).padStart(4)}/${todo.length}] ${a.country.padEnd(14)} ${a.name.slice(0, 40).padEnd(40)} ${tag}`);
    } catch (e) {
      console.error(`  [${i}/${todo.length}] ${a.name}: ${e.message}`);
      await writeFile(GOOGLE_CACHE, JSON.stringify(googleCache, null, 2));
      throw e;
    }
    if (i % 25 === 0) await writeFile(GOOGLE_CACHE, JSON.stringify(googleCache, null, 2));
  }
  await writeFile(GOOGLE_CACHE, JSON.stringify(googleCache, null, 2));

  const { file, counts } = mergeAndWrite(segaData, nomCache, googleCache, { googleFirst: args.all });
  await writeFile(OUTPUT_FILE, JSON.stringify(file, null, 2));
  console.log(`\nWrote ${file.arcades.length} arcades to arcades.geocoded.json`);
  console.log(`  via Nominatim:           ${counts.nomCount}`);
  console.log(`  via Google Places:       ${counts.googleCount}`);
  console.log(`  no-match fallback:       ${counts.fallbackCount}`);
  console.log(`  not-yet-geocoded:        ${counts.originalCount}`);
}

await main();
