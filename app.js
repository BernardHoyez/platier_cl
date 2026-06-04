/* ═══════════════════════════════════════════════════════════════
   PLATIER_CL — Application principale
   BernardHoyez.github.io/platier_cl
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── CONSTANTES API IGN ───────────────────────────────────────────
// API REST altimétrique Geoplateforme (remplace WCS déprécié)
const IGN_ALTI_URL   = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_ALTI_RES   = 'ign_rge_alti_wld';   // ressource RGE Alti monde
const IGN_WMTS_BASE  = 'https://data.geopf.fr/wmts';
const IGN_ORTHO_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS';
const SHOM_WFS_BASE  = 'https://services.data.shom.fr/INSPIRE/wfs';

// Limite IGN : 40 points max par requête GET, 5 req/s
const ALTI_BATCH_SIZE = 40;
const ALTI_DELAY_MS   = 250; // 4 req/s pour rester sous la limite

// Tolérance de simplification du polygone estran (degrés)
const SIMPLIFY_TOL = 0.00005;
// Surface minimale des îlots à conserver (m²) — nettoyage géométrique
const MIN_AREA_M2  = 5000;

// ─── STATE ─────────────────────────────────────────────────────────
let state = {
  bbox: null,      // {minLon, minLat, maxLon, maxLat}
  estranPoly: null,// GeoJSON polygon
  mbtData: null,   // Uint8Array
  abortCtrl: null,
  t0: Date.now(),
};

// ─── DOM REFS ──────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const logArea      = $('logArea');
const progressFill = $('progressFill');
const progressLbl  = $('progressLabel');
const progressPct  = $('progressPct');
const globalStatus = $('globalStatus');
const downloadZone = $('downloadZone');

// ─── LOGGING ───────────────────────────────────────────────────────
function ts() {
  const s = Math.floor((Date.now() - state.t0) / 1000);
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}
function log(msg, level='info') {
  const d = document.createElement('div');
  d.className = `log-line ${level}`;
  d.innerHTML = `<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  logArea.appendChild(d);
  logArea.scrollTop = logArea.scrollHeight;
}

// ─── PROGRESS ──────────────────────────────────────────────────────
function setProgress(label, pct) {
  progressLbl.textContent = label;
  progressPct.textContent = Math.round(pct) + ' %';
  progressFill.style.width = pct + '%';
}

function setStatus(s) {
  const cls = {idle:'chip-idle', running:'chip-running', done:'chip-done', error:'chip-error'};
  const lbl = {idle:'Prêt', running:'En cours…', done:'Terminé', error:'Erreur'};
  globalStatus.className = 'status-chip ' + (cls[s]||'chip-idle');
  globalStatus.innerHTML = `<span class="dot"></span> ${lbl[s]||s}`;
}

// ─── CARTE ─────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [47.5, -2.0],
  zoom: 10,
  zoomControl: true,
});

// Fond carte IGN Plan
L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
  attribution: '© IGN Geoplateforme',
  maxZoom: 18,
}).addTo(map);

// Couche ortho (visible après sélection zone)
const orthoLayer = L.tileLayer(
  IGN_WMTS_BASE + '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image/jpeg` +
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  { maxZoom: 20, opacity: 0.7, attribution: '© IGN BD Ortho' }
);

// Leaflet Draw
const drawnItems = new L.FeatureGroup().addTo(map);
const drawControl = new L.Control.Draw({
  draw: {
    rectangle: { shapeOptions: { color: '#00c8a0', weight: 2 } },
    polygon: false, polyline: false, circle: false,
    circlemarker: false, marker: false,
  },
  edit: { featureGroup: drawnItems, remove: true },
});
map.addControl(drawControl);

// Layer estran
let estranLayer = null;

map.on(L.Draw.Event.CREATED, e => {
  drawnItems.clearLayers();
  drawnItems.addLayer(e.layer);
  const b = e.layer.getBounds();
  state.bbox = {
    minLon: b.getWest(), minLat: b.getSouth(),
    maxLon: b.getEast(), maxLat: b.getNorth(),
  };
  updateBboxDisplay();
  orthoLayer.addTo(map);
  map.fitBounds(b, { padding: [20,20] });
  log(`Zone sélectionnée : ${fmt4(state.bbox.minLon)}, ${fmt4(state.bbox.minLat)} → ${fmt4(state.bbox.maxLon)}, ${fmt4(state.bbox.maxLat)}`, 'ok');
  enableStep2();
});

map.on(L.Draw.Event.DELETED, () => {
  state.bbox = null;
  updateBboxDisplay();
  disableStep2();
});

function fmt4(v) { return Number(v).toFixed(4); }

function updateBboxDisplay() {
  const b = state.bbox;
  $('cLonMin').textContent = b ? fmt4(b.minLon) : '—';
  $('cLonMax').textContent = b ? fmt4(b.maxLon) : '—';
  $('cLatMin').textContent = b ? fmt4(b.minLat) : '—';
  $('cLatMax').textContent = b ? fmt4(b.maxLat) : '—';
}

function enableStep2() {
  $('btnClear').disabled   = false;
  $('btnProcess').disabled = false;
  $('step2title').classList.remove('inactive');
  $('step3title').classList.remove('inactive');
}
function disableStep2() {
  $('btnClear').disabled   = true;
  $('btnProcess').disabled = true;
  $('step2title').classList.add('inactive');
  $('step3title').classList.add('inactive');
}

$('btnClear').addEventListener('click', () => {
  drawnItems.clearLayers();
  if (estranLayer) { map.removeLayer(estranLayer); estranLayer = null; }
  orthoLayer.remove();
  state.bbox = null; state.estranPoly = null; state.mbtData = null;
  downloadZone.classList.remove('visible');
  updateBboxDisplay();
  disableStep2();
  setProgress('En attente', 0);
  setStatus('idle');
  log('Zone effacée.', 'warn');
});

// ─── WMTS TILE XYZ ────────────────────────────────────────────────
function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tile(lat, z) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z)); }

function bboxToTiles(bbox, z) {
  const xMin = lon2tile(bbox.minLon, z);
  const xMax = lon2tile(bbox.maxLon, z);
  const yMin = lat2tile(bbox.maxLat, z); // lat inversée
  const yMax = lat2tile(bbox.minLat, z);
  const tiles = [];
  for (let x = xMin; x <= xMax; x++)
    for (let y = yMin; y <= yMax; y++)
      tiles.push({ z, x, y });
  return tiles;
}

function tileToWGS84(x, y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return {
    lon: x / Math.pow(2, z) * 360 - 180,
    lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
  };
}

// ─── FETCH AVEC ABORT ─────────────────────────────────────────────
async function fetchAb(url, opts = {}) {
  if (!state.abortCtrl || state.abortCtrl.signal.aborted) throw new Error('Annulé');
  opts.signal = state.abortCtrl.signal;
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} : ${url.substring(0,80)}`);
  return r;
}

// ─── IGN API REST ALTIMÉTRIQUE — RGE Alti ─────────────────────────
// Remplace l'ancien WCS (404). L'API retourne l'altitude de points discrets.
// On échantillonne une grille régulière sur la bbox, par lots de 40 points.
async function fetchMNT(bbox, res, onProgress) {
  // Résolution en degrés (approx, latitude moyenne)
  const latMid  = (bbox.minLat + bbox.maxLat) / 2;
  const mPerDegLon = 111320 * Math.cos(latMid * Math.PI / 180);
  const mPerDegLat = 111320;
  const stepLon = res / mPerDegLon;
  const stepLat = res / mPerDegLat;

  // Limiter la grille à 100×100 = 10 000 points max (évite trop de requêtes)
  const maxCols = 100, maxRows = 100;
  const rawCols = Math.ceil((bbox.maxLon - bbox.minLon) / stepLon);
  const rawRows = Math.ceil((bbox.maxLat - bbox.minLat) / stepLat);
  const cols = Math.min(rawCols, maxCols);
  const rows = Math.min(rawRows, maxRows);
  const actualStepLon = (bbox.maxLon - bbox.minLon) / (cols - 1 || 1);
  const actualStepLat = (bbox.maxLat - bbox.minLat) / (rows - 1 || 1);

  log(`Grille MNT : ${cols} × ${rows} = ${cols*rows} points (résolution ~${res} m)`, 'info');

  // Construire la liste de tous les points
  const allLons = [], allLats = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      allLons.push(bbox.minLon + c * actualStepLon);
      allLats.push(bbox.maxLat - r * actualStepLat); // lat décroissante (ligne 0 = nord)
    }
  }

  const total = allLons.length;
  const grid = new Float32Array(total).fill(NaN);

  log(`Interrogation API altimétrique IGN (${Math.ceil(total/ALTI_BATCH_SIZE)} requêtes)…`, 'info');

  for (let i = 0; i < total; i += ALTI_BATCH_SIZE) {
    if (state.abortCtrl?.signal.aborted) throw new Error('Annulé');

    const bLons = allLons.slice(i, i + ALTI_BATCH_SIZE);
    const bLats = allLats.slice(i, i + ALTI_BATCH_SIZE);

    const url = IGN_ALTI_URL + '?' + new URLSearchParams({
      lon:      bLons.map(v => v.toFixed(6)).join('|'),
      lat:      bLats.map(v => v.toFixed(6)).join('|'),
      resource: IGN_ALTI_RES,
      delimiter: '|',
      indent:   'false',
      measures: 'false',
      zonly:    'false',
    });

    const r = await fetchAb(url);
    const data = await r.json();
    const elevs = data.elevations || [];
    for (let j = 0; j < elevs.length; j++) {
      const z = elevs[j].z;
      // IGN retourne -99999 pour les zones non couvertes
      grid[i + j] = (z === null || z < -9990) ? NaN : z;
    }

    if (onProgress) onProgress(Math.min(i + ALTI_BATCH_SIZE, total), total);

    // Respecter la limite de taux (5 req/s)
    if (i + ALTI_BATCH_SIZE < total) {
      await new Promise(res => setTimeout(res, ALTI_DELAY_MS));
    }
  }

  // Statistiques
  let vmin=Infinity, vmax=-Infinity, cnt=0;
  for (let i=0; i<grid.length; i++) {
    if (!isNaN(grid[i])) { if(grid[i]<vmin)vmin=grid[i]; if(grid[i]>vmax)vmax=grid[i]; cnt++; }
  }
  log(`Grille MNT reçue : ${cnt}/${total} points valides, alt. ${vmin.toFixed(2)}–${vmax.toFixed(2)} m`, 'ok');

  return { grid, width: cols, height: rows, bbox };
}

// ─── EXTRACTION CONTOUR ESTRAN ────────────────────────────────────
// Méthode : marching squares simplifié pour les isocontours 0m et PMVE
function marchingSquaresIso(grid, w, h, isoVal) {
  // Retourne un tableau de polylignes [[x,y], ...]
  const segments = [];
  for (let row = 0; row < h - 1; row++) {
    for (let col = 0; col < w - 1; col++) {
      const tl = grid[row * w + col];
      const tr = grid[row * w + col + 1];
      const bl = grid[(row+1) * w + col];
      const br = grid[(row+1) * w + col + 1];
      if (isNaN(tl)||isNaN(tr)||isNaN(bl)||isNaN(br)) continue;
      const idx =
        (tl >= isoVal ? 8 : 0) |
        (tr >= isoVal ? 4 : 0) |
        (br >= isoVal ? 2 : 0) |
        (bl >= isoVal ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      // Interpolation linéaire
      function lerp(a, b) { return (isoVal - a) / (b - a); }
      const top    = col + lerp(tl, tr);
      const right  = row + lerp(tr, br);
      const bottom = col + lerp(bl, br);
      const left   = row + lerp(tl, bl);
      const pts = {
        t: [top, row], b: [bottom, row+1],
        l: [col, left], r: [col+1, right],
      };
      const cases = {
        1:  [pts.l, pts.b], 2:  [pts.b, pts.r],
        3:  [pts.l, pts.r], 4:  [pts.t, pts.r],
        5:  [pts.t, pts.l, pts.b, pts.r], // saddle
        6:  [pts.t, pts.b], 7:  [pts.t, pts.l],
        8:  [pts.t, pts.l], 9:  [pts.t, pts.b],
        10: [pts.t, pts.r, pts.b, pts.l], // saddle
        11: [pts.t, pts.r], 12: [pts.l, pts.r],
        13: [pts.b, pts.r], 14: [pts.l, pts.b],
      };
      const segs = cases[idx];
      if (!segs) continue;
      for (let i = 0; i < segs.length; i += 2) {
        if (segs[i] && segs[i+1]) segments.push([segs[i], segs[i+1]]);
      }
    }
  }
  return segments;
}

// Convertit coordonnées pixel → WGS84
function pixelToWGS84(px, py, width, height, bbox) {
  const lon = bbox.minLon + (px / width)  * (bbox.maxLon - bbox.minLon);
  const lat = bbox.maxLat - (py / height) * (bbox.maxLat - bbox.minLat);
  return [lon, lat];
}

// Connecte les segments en polylignes
function connectSegments(segments, width, height, bbox) {
  const lines = segments.map(seg => seg.map(([px,py]) => pixelToWGS84(px, py, width, height, bbox)));
  // Assemblage en chaînes par correspondance de points
  if (lines.length === 0) return [];
  const eps = 1e-7;
  const used = new Uint8Array(lines.length);
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = [...lines[i]];
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        const head = chain[0]; const tail = chain[chain.length-1];
        const a = lines[j][0]; const b = lines[j][1];
        if (Math.abs(tail[0]-a[0])<eps && Math.abs(tail[1]-a[1])<eps) {
          chain.push(b); used[j]=1; changed=true;
        } else if (Math.abs(tail[0]-b[0])<eps && Math.abs(tail[1]-b[1])<eps) {
          chain.push(a); used[j]=1; changed=true;
        } else if (Math.abs(head[0]-b[0])<eps && Math.abs(head[1]-b[1])<eps) {
          chain.unshift(a); used[j]=1; changed=true;
        } else if (Math.abs(head[0]-a[0])<eps && Math.abs(head[1]-a[1])<eps) {
          chain.unshift(b); used[j]=1; changed=true;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

// ─── CONSTRUCTION POLYGONE ESTRAN ─────────────────────────────────
function buildEstranPolygon(grid, width, height, bbox, pmveAlt) {
  log('Calcul des isocontours 0 m NGF…', 'info');
  const segs0    = marchingSquaresIso(grid, width, height, 0.0);
  log(`Calcul des isocontours PMVE (${pmveAlt} m NGF)…`, 'info');
  const segsPMVE = marchingSquaresIso(grid, width, height, pmveAlt);

  const chains0    = connectSegments(segs0,    width, height, bbox);
  const chainsPMVE = connectSegments(segsPMVE, width, height, bbox);

  log(`Isocontour 0 m : ${chains0.length} chaîne(s)`, 'info');
  log(`Isocontour PMVE : ${chainsPMVE.length} chaîne(s)`, 'info');

  // Limites latérales : bords ouest et est de la bbox
  const bboxPoly = [
    [bbox.minLon, bbox.minLat],
    [bbox.minLon, bbox.maxLat],
    [bbox.maxLon, bbox.maxLat],
    [bbox.maxLon, bbox.minLat],
    [bbox.minLon, bbox.minLat],
  ];

  // Construire le polygone estran = zone entre 0m et PMVE
  // On utilise Turf pour les opérations booléennes
  const rings = [];

  // Créer des polygones "à partir de la côte" entre les deux isocontours
  // Méthode simplifiée : masque entre les deux niveaux
  const estranMask = buildEstranMask(grid, width, height, bbox, pmveAlt);

  if (!estranMask) {
    log('Impossible de construire le masque estran (données insuffisantes)', 'warn');
    return null;
  }

  log('Nettoyage géométrique (suppression îlots < ' + MIN_AREA_M2 + ' m²)…', 'info');
  const cleaned = cleanPolygon(estranMask);
  return cleaned;
}

function buildEstranMask(grid, width, height, bbox, pmveAlt) {
  // Crée un GeoJSON polygon = union des cellules où 0 <= altitude <= pmveAlt
  const rings = [];
  const cellW = (bbox.maxLon - bbox.minLon) / width;
  const cellH = (bbox.maxLat - bbox.minLat) / height;

  // Rassemble les cellules dans la plage altitudinale
  const polys = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const v = grid[row * width + col];
      if (isNaN(v)) continue;
      if (v >= 0 && v <= pmveAlt) {
        const lon = bbox.minLon + col * cellW;
        const lat = bbox.maxLat - (row+1) * cellH;
        polys.push(turf.bboxPolygon([lon, lat, lon+cellW, lat+cellH]));
      }
    }
  }

  if (polys.length === 0) return null;

  log(`${polys.length} cellules estran identifiées, union en cours…`, 'info');

  // Union par lots pour les grandes zones
  let merged = polys[0];
  const batchSize = 200;
  for (let i = 1; i < polys.length; i += batchSize) {
    const batch = polys.slice(i, i + batchSize);
    const fc = turf.featureCollection([merged, ...batch]);
    try {
      merged = turf.union(...fc.features);
    } catch(e) {
      // si union échoue, conserver merged
    }
  }
  return merged;
}

function cleanPolygon(geojson) {
  if (!geojson) return null;
  // Simplifier
  const simplified = turf.simplify(geojson, { tolerance: SIMPLIFY_TOL, highQuality: false });
  // Supprimer les petits polygones (îlots internes ou externes)
  if (simplified.geometry.type === 'Polygon') {
    return simplified;
  }
  // MultiPolygon : filtrer par aire
  if (simplified.geometry.type === 'MultiPolygon') {
    const kept = simplified.geometry.coordinates.filter(coords => {
      const poly = turf.polygon(coords);
      const area = turf.area(poly);
      return area >= MIN_AREA_M2;
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return turf.polygon(kept[0]);
    return turf.multiPolygon(kept);
  }
  return simplified;
}

// ─── TUILES ORTHO ─────────────────────────────────────────────────
async function fetchOrthoTile(z, x, y) {
  const url = IGN_WMTS_BASE +
    `?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image/jpeg` +
    `&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  const r = await fetchAb(url);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

// ─── MBTILES ──────────────────────────────────────────────────────
async function buildMBTiles(tiles, estranPoly, zoom, onProgress) {
  log('Initialisation SQLite (sql.js)…', 'info');

  const SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });
  const db = new SQL.Database();

  // Schéma MBTiles standard
  db.run(`CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS tiles (
    zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,
    tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row)
  );`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS tile_idx
    ON tiles (zoom_level, tile_column, tile_row);`);

  // Metadata
  const meta = [
    ['name',        'Estran IGN Platier CL'],
    ['type',        'baselayer'],
    ['version',     '1.0'],
    ['description', 'Orthophotos IGN dans la zone estran'],
    ['format',      'jpg'],
    ['minzoom',     String(zoom)],
    ['maxzoom',     String(zoom)],
  ];
  for (const [k,v] of meta) db.run('INSERT INTO metadata VALUES (?,?)', [k,v]);

  // Filtrer les tuiles intersectant le polygone estran
  const validTiles = estranPoly
    ? tiles.filter(t => {
        const sw = tileToWGS84(t.x,   t.y+1, t.z);
        const ne = tileToWGS84(t.x+1, t.y,   t.z);
        const tileBox = turf.bboxPolygon([sw.lon, sw.lat, ne.lon, ne.lat]);
        try { return turf.booleanIntersects(estranPoly, tileBox); }
        catch { return true; }
      })
    : tiles;

  log(`Tuiles à télécharger : ${validTiles.length} (zoom ${zoom})`, 'info');

  const stmt = db.prepare(
    'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)'
  );

  let done = 0;
  const total = validTiles.length;
  const CONCURRENCY = 4;

  for (let i = 0; i < validTiles.length; i += CONCURRENCY) {
    if (state.abortCtrl?.signal.aborted) throw new Error('Annulé');
    const batch = validTiles.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(t => fetchOrthoTile(t.z, t.x, t.y)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j].status === 'fulfilled') {
        const { z, x, y } = batch[j];
        // MBTiles : tile_row = inversé (TMS)
        const tmsY = Math.pow(2, z) - 1 - y;
        stmt.run([z, x, tmsY, results[j].value]);
        done++;
      } else {
        log(`Tuile ${batch[j].z}/${batch[j].x}/${batch[j].y} échouée`, 'warn');
        done++;
      }
    }
    onProgress(done, total);
  }

  stmt.free();
  const data = db.export();
  db.close();
  return data;
}

// ─── PIPELINE PRINCIPAL ───────────────────────────────────────────
async function runPipeline() {
  if (!state.bbox) { log('Aucune zone sélectionnée.', 'warn'); return; }

  state.t0 = Date.now();
  state.abortCtrl = new AbortController();

  $('btnProcess').disabled = true;
  $('btnAbort').disabled   = false;
  downloadZone.classList.remove('visible');
  setStatus('running');

  const bbox    = state.bbox;
  const pmveAlt = parseFloat($('pmveAlt').value) || 5.0;
  const res     = parseInt($('mntRes').value) || 5;
  const zoom    = parseInt($('orthoZoom').value) || 17;

  try {
    // ── ÉTAPE 1 : MNT via API REST IGN altimétrique ───────────────
    setProgress('Téléchargement altimétrie IGN RGE Alti…', 5);
    log('Téléchargement MNT IGN via API REST altimétrique…', 'info');
    const { grid, width, height } = await fetchMNT(bbox, res, (done, total) => {
      const pct = 5 + 25 * (done / total);
      setProgress(`Altimétrie : ${done}/${total} points`, pct);
    });

    if (grid.every(v => isNaN(v))) {
      throw new Error('Aucune donnée altimétrique reçue — vérifiez la zone sélectionnée.');
    }

    // Vérification de la plage altitudinale
    let vmin=Infinity, vmax=-Infinity;
    for (let i=0; i<grid.length; i++) {
      if (!isNaN(grid[i])) { if(grid[i]<vmin)vmin=grid[i]; if(grid[i]>vmax)vmax=grid[i]; }
    }
    if (vmax < 0 || vmin > pmveAlt) {
      log(`⚠ La zone ne semble pas comporter d'estran (altitude hors [0, ${pmveAlt}])`, 'warn');
    }

    // ── ÉTAPE 2 : Polygone estran ──────────────────────────────────
    setProgress('Construction du polygone estran…', 35);
    const estranPoly = buildEstranPolygon(grid, width, height, bbox, pmveAlt);

    if (estranPoly) {
      state.estranPoly = estranPoly;
      // Afficher sur la carte
      if (estranLayer) map.removeLayer(estranLayer);
      estranLayer = L.geoJSON(estranPoly, {
        style: { color: '#00c8a0', weight: 2, fillColor: '#00c8a0', fillOpacity: 0.25 }
      }).addTo(map);
      log('Polygone estran construit et affiché.', 'ok');
    } else {
      log('Aucun polygone estran trouvé dans la zone.', 'warn');
    }

    // ── ÉTAPE 3 : Tuiles ortho ────────────────────────────────────
    setProgress('Calcul des tuiles WMTS…', 50);
    const tiles = bboxToTiles(bbox, zoom);
    log(`Tuiles WMTS zoom ${zoom} dans la bbox : ${tiles.length}`, 'info');

    if (tiles.length > 2000) {
      log(`⚠ ${tiles.length} tuiles — cela peut prendre du temps et consommer de la mémoire.`, 'warn');
    }

    // ── ÉTAPE 4 : MBTiles ─────────────────────────────────────────
    setProgress('Assemblage MBTiles…', 55);
    log('Démarrage de l\'assemblage MBTiles…', 'info');

    const mbtData = await buildMBTiles(tiles, estranPoly, zoom, (done, total) => {
      const pct = 55 + 40 * (done / total);
      setProgress(`Tuiles : ${done}/${total}`, pct);
    });

    state.mbtData = mbtData;
    const sizeKo = (mbtData.byteLength / 1024).toFixed(1);
    const sizeMo = (mbtData.byteLength / 1024 / 1024).toFixed(2);

    // ── ÉTAPE 5 : Proposer le téléchargement ──────────────────────
    setProgress('Terminé !', 100);
    setStatus('done');

    $('mbtSize').textContent = sizeKo > 1024 ? `${sizeMo} Mo` : `${sizeKo} Ko`;
    downloadZone.classList.add('visible');
    log(`MBTiles généré : ${sizeMo} Mo — prêt au téléchargement.`, 'ok');
    log('Pipeline terminé avec succès.', 'ok');

  } catch(err) {
    if (err.message === 'Annulé' || err.name === 'AbortError') {
      log('Traitement annulé.', 'warn');
      setStatus('idle');
      setProgress('Annulé', 0);
    } else {
      log(`ERREUR : ${err.message}`, 'err');
      console.error(err);
      setStatus('error');
      setProgress('Erreur', 0);
    }
  } finally {
    $('btnProcess').disabled = false;
    $('btnAbort').disabled   = true;
    state.abortCtrl = null;
  }
}

// ─── TÉLÉCHARGEMENT ───────────────────────────────────────────────
$('btnDownload').addEventListener('click', () => {
  if (!state.mbtData) return;
  const blob = new Blob([state.mbtData], { type: 'application/x-sqlite3' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'estran.mbtiles';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log('Téléchargement démarré : estran.mbtiles', 'ok');
});

$('btnProcess').addEventListener('click', runPipeline);

$('btnAbort').addEventListener('click', () => {
  if (state.abortCtrl) { state.abortCtrl.abort(); log('Annulation demandée…', 'warn'); }
});

// ─── CURSOR COORDS ────────────────────────────────────────────────
const mapInfo = $('mapInfo');
map.on('mousemove', e => {
  mapInfo.style.display = 'block';
  mapInfo.textContent = `${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;
});
map.on('mouseout', () => { mapInfo.style.display = 'none'; });

// ─── SERVICE WORKER ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    console.log('[PWA] SW enregistré', reg.scope);
  }).catch(err => console.warn('[PWA] SW erreur', err));
}

log('Platier CL prêt. Dessinez un rectangle pour commencer.', 'ok');
