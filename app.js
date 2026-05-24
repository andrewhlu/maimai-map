const FAMILY = {
  maimai: 'maimai', maimai_intl: 'maimai', maimai_cn: 'maimai',
  chunithm: 'chunithm', chunithm_intl: 'chunithm', chunithm_cn: 'chunithm',
  ongeki: 'ongeki',
};
const FAMILY_ORDER = ['maimai', 'chunithm', 'ongeki'];
const VARIANT_LABEL = {
  maimai: 'maimai DX', maimai_intl: 'maimai DX International', maimai_cn: 'maimai DX (China)',
  chunithm: 'CHUNITHM', chunithm_intl: 'CHUNITHM International', chunithm_cn: 'CHUNITHM (China)',
  ongeki: 'Ongeki',
};
const VARIANT_BADGE_CLASS = {
  maimai: 'maimai', maimai_intl: 'maimai-intl', maimai_cn: 'maimai-cn',
  chunithm: 'chunithm', chunithm_intl: 'chunithm-intl', chunithm_cn: 'chunithm-cn',
  ongeki: 'ongeki',
};

const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([20, 100], 3);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });
map.addLayer(cluster);

const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

function makeIcon(games) {
  const families = [...new Set(games.map(g => FAMILY[g]))]
    .sort((a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b));
  const stripes = families.map(f => `<div class="stripe ${f}"></div>`).join('');
  return L.divIcon({
    className: '',
    html: `<div class="arcade-pin">${stripes}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

function popupHtml(a) {
  const meta = a.prefecture ? `${a.country} · ${a.prefecture}` : a.country;
  const badges = a.games
    .slice()
    .sort((x, y) => Object.keys(VARIANT_LABEL).indexOf(x) - Object.keys(VARIANT_LABEL).indexOf(y))
    .map(v => `<span class="badge ${VARIANT_BADGE_CLASS[v]}">${VARIANT_LABEL[v]}</span>`)
    .join('');
  const gmapsCoord = `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lon}`;
  const amapsCoord = `https://maps.apple.com/?ll=${a.lat},${a.lon}&q=${encodeURIComponent(a.name)}`;
  const gmapsName = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.name + ', ' + a.address)}`;
  const amapsName = `https://maps.apple.com/?q=${encodeURIComponent(a.name + ', ' + a.address)}`;
  let geoLine = '';
  if (a.geocoding?.source === 'nominatim') {
    geoLine = `<div class="meta" style="color:#15803d">✓ Nominatim-geocoded</div>`;
  } else if (a.geocoding?.source === 'google_places') {
    geoLine = `<div class="meta" style="color:#15803d">✓ Google Places-geocoded</div>`;
  } else if (a.geocoding?.source === 'sega_fallback') {
    geoLine = `<div class="meta" style="color:#b45309">⚠ No geocode match — using SEGA's coords</div>`;
  } else if (a.geocoding?.source === 'province_centroid') {
    geoLine = `<div class="meta" style="color:#b45309">⚠ Approximate location (province centroid)</div>`;
  } else if (a.geocoding?.source === 'sega_official_japan') {
    geoLine = `<div class="meta" style="color:#15803d">✓ SEGA-official coordinates</div>`;
  }
  return `
    <strong>${escapeHtml(a.name)}</strong>
    <div class="meta">${escapeHtml(meta)}</div>
    ${geoLine}
    <div class="addr">${escapeHtml(a.address)}</div>
    <div class="games">${badges}</div>
    <div class="links">
      <div>By coords: <a href="${gmapsCoord}" target="_blank" rel="noopener">Google Maps</a> · <a href="${amapsCoord}" target="_blank" rel="noopener">Apple Maps</a></div>
      <div>By name: <a href="${gmapsName}" target="_blank" rel="noopener">Google Maps</a> · <a href="${amapsName}" target="_blank" rel="noopener">Apple Maps</a></div>
    </div>
  `;
}

// Haversine distance in km between two [lat, lon] points.
function distanceKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Format a distance with both metric and imperial units, switching units
// for sub-kilometre / sub-mile distances so the numbers stay readable.
function formatDistance(km) {
  const mi = km * 0.621371;
  const metric = km < 1 ? `${Math.round(km * 1000)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  const imperial = mi < 0.1 ? `${Math.round(km * 3280.84)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  return `${metric} / ${imperial}`;
}

// Format a GPS accuracy radius (always in metres input) with both units.
function formatAccuracy(metres) {
  const ft = metres * 3.28084;
  return `±${Math.round(metres)} m / ±${Math.round(ft)} ft`;
}

let segaArcades = [];
let geocodedArcades = null; // null until arcades.geocoded.json is loaded
let allArcades = [];        // currently active set, equal to one of the above
let markerByArcade = new Map(); // arcade -> L.marker
let arcadeBySid = new Map();    // any sid (from id or detail_urls) -> arcade
let userMarker = null, userAccuracyCircle = null;
let suppressHashUpdate = false;

function visibleArcades() {
  const country = document.getElementById('country-select').value;
  const pref = document.getElementById('pref-select').value;
  const enabledVariants = new Set(
    [...document.querySelectorAll('.game-toggle:checked')].map(el => el.value)
  );
  return allArcades.filter(a => {
    if (country && String(a.country_code) !== country) return false;
    // Subdivision filter applies to both Japan (prefecture) and China (province),
    // both of which are stored in arcade.prefecture.
    if ((country === '1000' || country === '1100') && pref && a.prefecture !== pref) return false;
    return a.games.some(g => enabledVariants.has(g));
  });
}

function refreshMarkers(fitBounds = true) {
  cluster.clearLayers();
  const visible = visibleArcades();
  const layers = visible.map(a => markerByArcade.get(a)).filter(Boolean);
  cluster.addLayers(layers);
  if (fitBounds && layers.length) {
    const bounds = L.featureGroup(layers).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));
  }
}

// Sub-dropdown content per country: prefectures for Japan, provinces for China.
// Stored in a closure so the country change handler can swap options without
// re-querying the data file.
let SUBDIVISIONS = { '1000': [], '1100': [] };

function populateSelectors(data) {
  const cs = document.getElementById('country-select');
  for (const c of data.countries) {
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = `${c.name} (${c.count})`;
    cs.appendChild(opt);
  }
  SUBDIVISIONS = {
    '1000': data.prefectures ?? [],
    '1100': data.provinces ?? [],
  };
}

function setSubdivisionOptions(countryCode) {
  const ps = document.getElementById('pref-select');
  // Reset to "All" option; preserve the placeholder label per country.
  const allLabel = countryCode === '1000' ? 'All prefectures'
                 : countryCode === '1100' ? 'All provinces'
                 : 'All';
  ps.innerHTML = `<option value="">${allLabel}</option>`;
  for (const p of (SUBDIVISIONS[countryCode] ?? [])) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} (${p.count})`;
    ps.appendChild(opt);
  }
}

function locateMe() {
  const status = document.getElementById('locate-status');
  const btn = document.getElementById('locate-btn');
  status.className = ''; status.textContent = '';
  if (!navigator.geolocation) {
    status.className = 'error';
    status.textContent = 'Geolocation not supported by this browser.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      btn.disabled = false;
      btn.textContent = '📍 Show my location';
      const { latitude, longitude, accuracy } = pos.coords;
      const me = [latitude, longitude];

      if (userMarker) map.removeLayer(userMarker);
      if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);

      userMarker = L.marker(me, {
        icon: L.divIcon({ className: '', html: '<div class="me-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        zIndexOffset: 1000,
      }).addTo(map);
      userAccuracyCircle = L.circle(me, { radius: accuracy, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.1, weight: 1 }).addTo(map);

      // Find nearest visible arcade.
      const visible = visibleArcades();
      let nearest = null, nearestDist = Infinity;
      for (const a of visible) {
        const d = distanceKm(me, [a.lat, a.lon]);
        if (d < nearestDist) { nearestDist = d; nearest = a; }
      }

      let popup = `<strong>You are here</strong><div class="meta">${formatAccuracy(accuracy)}</div>`;
      if (nearest) {
        popup += `<div class="addr">Nearest arcade: <strong>${escapeHtml(nearest.name)}</strong> (${formatDistance(nearestDist)})</div>`;
      }
      userMarker.bindPopup(popup).openPopup();

      status.className = 'ok';
      status.textContent = nearest
        ? `Nearest: ${nearest.name} (${formatDistance(nearestDist)})`
        : 'Located, but no visible arcades to compare.';

      if (nearest) {
        map.fitBounds(L.latLngBounds([me, [nearest.lat, nearest.lon]]).pad(0.3));
      } else {
        map.setView(me, 13);
      }
    },
    err => {
      btn.disabled = false;
      btn.textContent = '📍 Show my location';
      status.className = 'error';
      status.textContent = `Couldn't get location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

function buildMarkers() {
  markerByArcade = new Map();
  arcadeBySid = new Map();
  for (const a of allArcades) {
    const m = L.marker([a.lat, a.lon], { icon: makeIcon(a.games) });
    m.bindPopup(() => popupHtml(a));
    m.on('popupopen', () => {
      if (suppressHashUpdate || a.id == null) return;
      history.replaceState(null, '', `#id=${a.id}`);
    });
    m.on('popupclose', () => {
      if (suppressHashUpdate) return;
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    });
    markerByArcade.set(a, m);
    if (a.id != null) arcadeBySid.set(String(a.id), a);
    // Also index every variant's sid so deep links work even when
    // variants disagree on sid (rare — 8 arcades in current data).
    for (const url of Object.values(a.detail_urls)) {
      const sid = url.match(/sid=(\d+)/)?.[1];
      if (sid) arcadeBySid.set(sid, a);
    }
  }
}

function readIdFromHash() {
  const m = location.hash.match(/(?:^#|&)id=(\d+)/);
  return m ? m[1] : null;
}

function focusArcade(arcade) {
  // Make sure the arcade passes current filters; if not, clear them so
  // it shows up. Cheaper than tracking which filter is excluding it —
  // a deep-linked arcade should always be visible.
  const country = document.getElementById('country-select');
  const pref = document.getElementById('pref-select');
  let needsRefresh = false;
  if (country.value && String(arcade.country_code) !== country.value) {
    country.value = '';
    pref.style.display = 'none';
    pref.value = '';
    needsRefresh = true;
  } else if ((country.value === '1000' || country.value === '1100') && pref.value && arcade.prefecture !== pref.value) {
    pref.value = '';
    needsRefresh = true;
  }
  // Make sure at least one of the arcade's variants is enabled.
  const enabled = new Set([...document.querySelectorAll('.game-toggle:checked')].map(el => el.value));
  const visible = arcade.games.some(g => enabled.has(g));
  if (!visible) {
    for (const cb of document.querySelectorAll('.game-toggle')) {
      if (arcade.games.includes(cb.value)) cb.checked = true;
    }
    needsRefresh = true;
  }
  if (needsRefresh) refreshMarkers(false);

  const m = markerByArcade.get(arcade);
  if (!m) return;
  // Zoom in to a useful level and open the popup. A small delay lets
  // markercluster finish adding the marker to the cluster group.
  const targetZoom = Math.max(map.getZoom(), 16);
  map.setView([arcade.lat, arcade.lon], targetZoom, { animate: true });
  setTimeout(() => {
    if (cluster.hasLayer(m)) {
      // If marker is inside a cluster, this will spider/zoom it open.
      cluster.zoomToShowLayer(m, () => m.openPopup());
    } else {
      m.openPopup();
    }
  }, 250);
}

function applyHash() {
  const id = readIdFromHash();
  if (!id) return;
  const arcade = arcadeBySid.get(id);
  if (!arcade) {
    console.warn(`No arcade with sid=${id}`);
    return;
  }
  suppressHashUpdate = true;
  focusArcade(arcade);
  // Re-enable hash updates after the popup-open event has fired.
  setTimeout(() => { suppressHashUpdate = false; }, 1000);
}

function setSource(which) {
  allArcades = which === 'geocoded' && geocodedArcades ? geocodedArcades : segaArcades;
  buildMarkers();
  refreshMarkers(false);
  // Re-open the deep-linked popup against the new marker if one is active.
  const id = readIdFromHash();
  if (id && arcadeBySid.has(id)) {
    suppressHashUpdate = true;
    focusArcade(arcadeBySid.get(id));
    setTimeout(() => { suppressHashUpdate = false; }, 1000);
  }
}

async function init() {
  const data = await fetch('arcades.json').then(r => r.json());
  segaArcades = data.arcades;
  allArcades = segaArcades;

  // Optional: load arcades.geocoded.json if present.
  try {
    const geo = await fetch('arcades.geocoded.json').then(r => r.ok ? r.json() : null);
    if (geo) {
      geocodedArcades = geo.arcades;
      const cov = geo.geocoder?.coverage;
      const section = document.getElementById('source-section');
      section.style.display = '';
      if (cov) {
        const parts = [];
        if (cov.nominatim != null) parts.push(`${cov.nominatim} via Nominatim`);
        if (cov.google_places) parts.push(`${cov.google_places} via Google`);
        if (cov.geocoded != null) parts.push(`${cov.geocoded} geocoded`);
        if (cov.no_match_fallback) parts.push(`${cov.no_match_fallback} no-match`);
        if (cov.not_yet_geocoded) parts.push(`${cov.not_yet_geocoded} not yet processed`);
        document.getElementById('source-stats').textContent = parts.join(' · ');
      }
      for (const r of document.querySelectorAll('input[name=source]')) {
        r.addEventListener('change', e => setSource(e.target.value));
      }
    }
  } catch (e) {
    // No geocoded file — toggle stays hidden.
  }

  document.getElementById('stats').textContent =
    `${segaArcades.length.toLocaleString()} arcades · ${data.countries.length} countries`;
  document.getElementById('scraped').textContent =
    `Last scraped ${new Date(data.scraped_at).toLocaleString()}`;

  const sourcesDiv = document.getElementById('sources');
  const sourceLabels = {
    maimai: 'maimai (JP)', maimai_intl: 'maimai (Intl)',
    chunithm: 'CHUNITHM (JP)', chunithm_intl: 'CHUNITHM (Intl)',
    ongeki: 'Ongeki',
  };
  sourcesDiv.innerHTML = Object.entries(data.source_urls)
    .map(([k, url]) => `<a href="${url}" target="_blank" rel="noopener">${sourceLabels[k] || k}</a>`)
    .join(' · ');

  populateSelectors(data);

  buildMarkers();
  const initialId = readIdFromHash();
  // If we're deep-linking, skip the global fitBounds; focusArcade will frame the view.
  refreshMarkers(!initialId);
  if (initialId) applyHash();

  window.addEventListener('hashchange', applyHash);

  document.getElementById('country-select').addEventListener('change', e => {
    const value = e.target.value;
    const ps = document.getElementById('pref-select');
    const hasSubdivisions = value === '1000' || value === '1100';
    ps.style.display = hasSubdivisions ? '' : 'none';
    if (hasSubdivisions) setSubdivisionOptions(value);
    else ps.value = '';
    refreshMarkers(true);
  });
  document.getElementById('pref-select').addEventListener('change', () => refreshMarkers(true));
  for (const cb of document.querySelectorAll('.game-toggle')) {
    cb.addEventListener('change', () => refreshMarkers(false));
  }
  document.getElementById('locate-btn').addEventListener('click', locateMe);

  // Mobile hamburger toggle.
  const menuBtn = document.getElementById('menu-btn');
  const setMenuOpen = open => {
    document.body.classList.toggle('menu-open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Toggle menu');
    // Morph hamburger into an X via the three lines.
    const l1 = document.getElementById('menu-line-1');
    const l2 = document.getElementById('menu-line-2');
    const l3 = document.getElementById('menu-line-3');
    if (open) {
      l1.setAttribute('x1', '5');  l1.setAttribute('y1', '5');  l1.setAttribute('x2', '19'); l1.setAttribute('y2', '19');
      l2.setAttribute('x1', '12'); l2.setAttribute('x2', '12');
      l2.style.opacity = '0';
      l3.setAttribute('x1', '5');  l3.setAttribute('y1', '19'); l3.setAttribute('x2', '19'); l3.setAttribute('y2', '5');
    } else {
      l1.setAttribute('x1', '3');  l1.setAttribute('y1', '6');  l1.setAttribute('x2', '21'); l1.setAttribute('y2', '6');
      l2.setAttribute('x1', '3');  l2.setAttribute('y1', '12'); l2.setAttribute('x2', '21'); l2.setAttribute('y2', '12');
      l2.style.opacity = '1';
      l3.setAttribute('x1', '3');  l3.setAttribute('y1', '18'); l3.setAttribute('x2', '21'); l3.setAttribute('y2', '18');
    }
    if (!open) {
      // After hiding the panel, the map becomes visible again — Leaflet
      // needs a kick to recompute its size if the viewport changed.
      setTimeout(() => map.invalidateSize(), 50);
    }
  };
  menuBtn.addEventListener('click', () => {
    setMenuOpen(!document.body.classList.contains('menu-open'));
  });
  // When a popup-bound action collapses to map-view (e.g. tapping a
  // country dropdown on mobile shouldn't auto-close the menu), but
  // tapping "Show my location" should — same for any control whose
  // value is "submit and view the map". Geolocate closes the menu.
  document.getElementById('locate-btn').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 640px)').matches) setMenuOpen(false);
  });
}

init().catch(err => {
  document.getElementById('stats').textContent = 'Failed to load arcades.json — see console.';
  console.error(err);
});
