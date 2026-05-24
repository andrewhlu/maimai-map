# SEGA rhythm-game arcade map

A static web app showing every arcade worldwide that has SEGA's rhythm games — **maimai DX**, **CHUNITHM**, and **Ongeki** — plotted on an OpenStreetMap layer using Leaflet.

Data is scraped once from SEGA's official location finder and saved to `arcades.json`. The frontend is a single `index.html` with no build step.

## View it

The map needs to be served over HTTP (a `file://` open is blocked by some browsers from `fetch()`-ing local JSON, and the geolocation API only works on `http://localhost` or HTTPS):

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Re-scrape

Requires Node.js ≥ 18 (for global `fetch`). No dependencies, no `npm install`:

```sh
node scrape.mjs
```

This makes ~166 requests at 400 ms intervals (≈ 70 seconds) and overwrites `arcades.json`.

## Scrape (China / Wahlap)

Mainland China is served by **Wahlap**, the Chinese licensee, not SEGA — it has its own scraper:

```sh
node scrape-cn.mjs
```

This hits two JSON endpoints (`https://sega-register.wahlap.net/api/sega/{maidx,midtr}/rest/location`), no rate-limiting needed, and merges 3,000+ China arcades into the existing `arcades.json` (replacing any prior China entries — re-running is idempotent). Two new variants are added: `maimai_cn` and `chunithm_cn`.

Wahlap's API does **not** return coordinates, so every China arcade is initially plotted at its **province centroid** (popups show "⚠ Approximate location"). To upgrade those to street-level coords, run `geocode.mjs` and/or `geocode-google.mjs` afterwards — they pick up the China entries automatically and treat the province centroid as the no-match fallback.

## Geocode (optional)

SEGA's listings include lat/lon, but some are wrong (e.g. an address geocoded to the wrong city). To produce a corrected dataset, query the OpenStreetMap **Nominatim** API for each arcade by name + address:

```sh
node geocode.mjs                     # geocode every arcade not yet in the cache
node geocode.mjs --limit 20          # quick sanity test
node geocode.mjs --country malaysia  # restrict to one country
node geocode.mjs --cn-only           # only mainland China (Wahlap entries)
node geocode.mjs --no-cn             # everywhere except mainland China
node geocode.mjs --force             # ignore cache, re-query everything
```

Japan is always skipped — SEGA's official listings already include accurate coordinates, so re-geocoding them only worsens the data. Those entries are tagged `geocoding.source = "sega_official_japan"` in the output.

Nominatim's free public endpoint is rate-limited to **1 request per second**, so a full run of all 1,683 arcades takes ~30+ minutes. Results are cached to `geocode.cache.json`, so reruns and partial runs are cheap. Output goes to `arcades.geocoded.json` — `arcades.json` is left untouched.

Behaviour:
- For each arcade, queries are tried from most specific to least specific (`name + address + country` → `name + country` → `address + country`).
- Results are restricted to the expected country via Nominatim's `countrycodes` filter.
- If no result lands in the expected country, we fall back to SEGA's original coordinates and tag `geocoding.source = "sega_fallback"`.
- Each geocoded arcade keeps SEGA's original coordinates under `geocoding.original_lat / .original_lon`.

When `arcades.geocoded.json` exists, the web app shows a **Coordinate source** toggle (SEGA original vs Nominatim-geocoded). Popups also indicate which arcades were successfully re-geocoded vs fell back.

## Geocode (Google Places fallback)

Nominatim sometimes returns no result for arcades inside malls or with unusual names. To fill those gaps, run the Google Places fallback after `geocode.mjs`. The script reads your API key from a `.env` file (or a real env var):

```sh
cp .env.example .env
# edit .env and paste your key after GOOGLE_MAPS_API_KEY=
node geocode-google.mjs
```

The `.env` file is gitignored so the key never leaves your machine. Setting `GOOGLE_MAPS_API_KEY` directly in your shell still works and takes precedence over the file.

This script *only* queries Google for arcades where Nominatim returned no match (it reads `geocode.cache.json` to find them). Results go to `google.cache.json`, and the merged `arcades.geocoded.json` will tag those arcades with `geocoding.source = "google_places"`.

Flags:
- `--all` — build the entire dataset against Google Places (Google becomes the primary source instead of Nominatim). See "Cost — full Google build" below.
- `--limit N` — only the first N candidates (handy for cost-controlled trials)
- `--country malaysia` — restrict to one country
- `--cn-only` — only mainland China (Wahlap entries)
- `--no-cn` — everywhere except mainland China
- `--force` — ignore the Google cache and re-query everything
- `--include-misses` — also retry candidates that Google previously returned no match for
- `--yes` / `-y` — skip the cost-confirmation prompt (for scripted runs)

Japan is always skipped (same as `geocode.mjs`).

### Cost — full Google build (`--all`)

Running `--all` against the current data (1,683 arcades) is what you'd do if you wanted a Google-only dataset rather than Nominatim-with-Google-fallback. The pricing below is for **Places API (New) — Text Search** at the published rate of $0.032/call (verify against [the SKU page](https://developers.google.com/maps/billing-and-pricing/pricing) if Google's pricing has changed):

| Calls | Gross cost | After $200/mo free credit |
|---|---|---|
| Expected (~1.2 calls/arcade): **~2,020** | **$64.64** | **$0.00** |
| Worst case (3 queries each): ~5,049 | $161.57 | $0.00 |

Both expected and worst-case fit comfortably inside the $200/month recurring credit Google Maps Platform applies to all accounts, so a full one-time build should cost **$0 out of pocket** — provided you don't run other Maps SKUs that month and you cap the project's quotas to be safe (see step 6 of the GCP setup section below).

The script prints these numbers up front and prompts for confirmation before any run that would issue more than 100 calls. Pass `--yes` to skip the prompt.

### Getting a Google Maps Platform API key

The script uses the **Places API (New) — Text Search** endpoint. Steps to set up an API key in your GCP account:

1. **Create or select a project** at <https://console.cloud.google.com/>.
2. **Enable billing** for the project (Billing → Link a billing account). You won't be charged for typical usage — Google Maps Platform includes a recurring **$200/month free credit** that covers ~6,250 Text Search calls per month.
3. **Enable the Places API (New)**: <https://console.cloud.google.com/apis/library/places.googleapis.com>. Click "Enable". (Note: this is the *new* Places API, not the legacy "Places API". The script will not work with the legacy one.)
4. **Create an API key**: APIs & Services → Credentials → "Create Credentials" → "API key". Copy the key.
5. **Restrict the key** (strongly recommended):
   - Under **Application restrictions**, choose "None" (the script runs from your laptop, not a known IP/referrer). If you want stricter security, choose "IP addresses" and add your home IP.
   - Under **API restrictions**, select "Restrict key" and tick only **Places API (New)**. This prevents the key from being abused for other Maps services if it ever leaks.
6. **(Optional) Set a quota cap**: APIs & Services → Places API (New) → Quotas. Cap "Text Search requests per minute per project" or set a daily cap to avoid surprise bills if a script bug runs away. For safety I recommend `1,000` requests/day — well above what this tool needs.
7. **Store the key in `.env` only** (gitignored) or pass it as an env var — never commit it. Create the key fresh for this project and revoke any old shared keys.

```sh
echo 'GOOGLE_MAPS_API_KEY=AIza...' > .env
node geocode-google.mjs --limit 10   # sanity check first
node geocode-google.mjs              # full run on all Nominatim no-match entries
```

The script prints an estimated cost up front based on the current Text Search rate (~$0.032 per call). Most users will stay well within the $200/month free credit.

## Data sources

All data comes from SEGA's ALL.Net Games Locator (`location.am-all.net`):

| Game | Locator |
|------|---------|
| maimai DX (Japan) | https://location.am-all.net/alm/location?gm=96 |
| maimai DX International | https://location.am-all.net/alm/location?gm=98 |
| CHUNITHM (Japan) | https://location.am-all.net/alm/location?gm=109 |
| CHUNITHM International | https://location.am-all.net/alm/location?gm=104 |
| Ongeki (Japan only) | https://location.am-all.net/alm/location?gm=88 |

Listings change over time as arcades open and close — re-run the scraper periodically to refresh. There is no affiliation with SEGA.
