/* ═══════════════════════════════════════════════════════════════
   PLATIER_CL — Application principale
   BernardHoyez.github.io/platier_cl
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ─── CONSTANTES API IGN ───────────────────────────────────────────
const IGN_WCS_BASE   = 'https://data.geopf.fr/wcs';
const IGN_WMTS_BASE  = 'https://data.geopf.fr/wmts';
const IGN_ORTHO_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ALTI_LAYER  = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const SHOM_WFS_BASE  = 'https://services.data.shom.fr/INSPIRE/wfs';

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

// ─── IGN WCS — RGE ALTI ───────────────────────────────────────────
async function fetchMNT(bbox, res) {
  // WCS 2.0 — GeoTIFF 32-bit float
  const resDeg = res / 111320; // approx
  const w = Math.ceil((bbox.maxLon - bbox.minLon) / resDeg);
  const h = Math.ceil((bbox.maxLat - bbox.minLat) / resDeg);
  const maxDim = 2000;
  const scaleW = w > maxDim ? maxDim : w;
  const scaleH = h > maxDim ? maxDim : h;

  const url = IGN_WCS_BASE + '?' + new URLSearchParams({
    SERVICE: 'WCS', VERSION: '2.0.1', REQUEST: 'GetCoverage',
    COVERAGEID: IGN_ALTI_LAYER,
    SUBSET: `Long(${bbox.minLon},${bbox.maxLon})`,
    SUBSETTING_CRS: 'http://www.opengis.net/def/crs/EPSG/0/4326',
    SUBSETBY: `Lat(${bbox.minLat},${bbox.maxLat})`,
    format: 'image/tiff',
    SCALESIZE: `Long(${scaleW}),Lat(${scaleH})`,
  });

  log('Téléchargement MNT IGN (RGE Alti)…', 'info');
  const r = await fetchAb(url);
  const buf = await r.arrayBuffer();
  log(`MNT reçu : ${(buf.byteLength/1024).toFixed(1)} Ko`, 'ok');
  return { buf, width: scaleW, height: scaleH, bbox };
}

// ─── PARSE GEOTIFF SIMPLIFIÉ (float32 single-band) ────────────────
// On utilise une approche manuelle pour lire les valeurs pixel du GeoTIFF.
// Pour les GeoTIFF IGN, on s'appuie sur le format connu (TIFF float32 big-endian ou little-endian).
async function parseTiffToGrid(buf) {
  // Chargement via image bitmap si possible, sinon parsing manuel
  // On utilise une approche canvas/createImageBitmap pour les tiffs 8-bit,
  // mais pour les tiffs float32 on doit parser le header TIFF.
  return parseTiffFloat32(buf);
}

function parseTiffFloat32(buf) {
  const view = new DataView(buf);
  const le = (view.getUint16(0) === 0x4949); // little-endian = II

  function ru16(o) { return view.getUint16(o, le); }
  function ru32(o) { return view.getUint32(o, le); }
  function ri32(o) { return view.getInt32(o, le); }
  function rf32(o) { return view.getFloat32(o, le); }

  const ifdOffset = ru32(4);
  const numEntries = ru16(ifdOffset);

  let width=0, height=0, bitsPerSample=0, sampleFormat=0;
  let stripOffsets=[], stripByteCounts=[], rowsPerStrip=0;
  let tileOffsets=[], tileByteCounts=[], tileWidth=0, tileHeight=0;
  let nodata = -9999;
  let samplesPerPixel = 1;
  let planarConfig = 1;
  let compression = 1;

  for (let i = 0; i < numEntries; i++) {
    const base = ifdOffset + 2 + i * 12;
    const tag = ru16(base);
    const type = ru16(base + 2);
    const count = ru32(base + 4);
    let val;
    if (type === 3) val = ru16(base + 8);
    else if (type === 4) val = ru32(base + 8);
    else if (type === 5) { const off = ru32(base+8); val = ru32(off) / ru32(off+4); }
    else val = ru32(base + 8);

    switch(tag) {
      case 256: width = val; break;
      case 257: height = val; break;
      case 258: bitsPerSample = val; break;
      case 259: compression = val; break;
      case 278: rowsPerStrip = val; break;
      case 273: { // strip offsets
        if (count === 1) stripOffsets = [val];
        else { const off = val; stripOffsets = []; for(let j=0;j<count;j++) stripOffsets.push(type===3?ru16(off+j*2):ru32(off+j*4)); }
        break; }
      case 279: { // strip byte counts
        if (count === 1) stripByteCounts = [val];
        else { const off = val; stripByteCounts = []; for(let j=0;j<count;j++) stripByteCounts.push(type===3?ru16(off+j*2):ru32(off+j*4)); }
        break; }
      case 277: samplesPerPixel = val; break;
      case 284: planarConfig = val; break;
      case 339: sampleFormat = val; break;
      case 322: tileWidth = val; break;
      case 323: tileHeight = val; break;
      case 324: { const off = ru32(base+8); tileOffsets=[]; for(let j=0;j<count;j++) tileOffsets.push(ru32(off+j*4)); break; }
      case 325: { const off = ru32(base+8); tileByteCounts=[]; for(let j=0;j<count;j++) tileByteCounts.push(ru32(off+j*4)); break; }
    }
  }

  // Allouer grille
  const grid = new Float32Array(width * height).fill(NaN);

  if (tileOffsets.length > 0) {
    // TILED
    const tilesAcross = Math.ceil(width / tileWidth);
    const tilesDown   = Math.ceil(height / tileHeight);
    for (let ti = 0; ti < tileOffsets.length; ti++) {
      const tx = (ti % tilesAcross) * tileWidth;
      const ty = Math.floor(ti / tilesAcross) * tileHeight;
      const off = tileOffsets[ti];
      for (let py = 0; py < tileHeight; py++) {
        for (let px = 0; px < tileWidth; px++) {
          const gx = tx + px; const gy = ty + py;
          if (gx < width && gy < height) {
            const dataOff = off + (py * tileWidth + px) * 4;
            const v = rf32(dataOff);
            grid[gy * width + gx] = (v === nodata || isNaN(v)) ? NaN : v;
          }
        }
      }
    }
  } else {
    // STRIPPED
    let row = 0;
    for (let si = 0; si < stripOffsets.length; si++) {
      const off = stripOffsets[si];
      const rows = rowsPerStrip || height;
      for (let sr = 0; sr < rows && row < height; sr++, row++) {
        for (let col = 0; col < width; col++) {
          const dataOff = off + (sr * width + col) * 4;
          const v = rf32(dataOff);
          grid[row * width + col] = (v <= nodata + 1 && v >= nodata - 1) ? NaN : v;
        }
      }
    }
  }

  return { grid, width, height };
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
    // ── ÉTAPE 1 : MNT ────────────────────────────────────────────
    setProgress('Téléchargement MNT IGN…', 5);
    const mnt = await fetchMNT(bbox, res);

    // ── ÉTAPE 2 : Parse TIFF ──────────────────────────────────────
    setProgress('Décodage GeoTIFF…', 20);
    log('Décodage GeoTIFF float32…', 'info');
    const { grid, width, height } = await parseTiffToGrid(mnt.buf);
    log(`Grille MNT : ${width} × ${height} pixels`, 'ok');

    // Statistiques rapides
    let vmin=Infinity, vmax=-Infinity, cnt=0;
    for (let i=0; i<grid.length; i++) {
      if (!isNaN(grid[i])) { if(grid[i]<vmin)vmin=grid[i]; if(grid[i]>vmax)vmax=grid[i]; cnt++; }
    }
    log(`Alt. min/max : ${vmin.toFixed(2)} m / ${vmax.toFixed(2)} m (${cnt} pixels valides)`, 'info');

    if (vmax < 0 || vmin > pmveAlt) {
      log(`⚠ La zone ne semble pas comporter d'estran (altitude hors [0, ${pmveAlt}])`, 'warn');
    }

    // ── ÉTAPE 3 : Polygone estran ──────────────────────────────────
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

    // ── ÉTAPE 4 : Tuiles ortho ────────────────────────────────────
    setProgress('Calcul des tuiles WMTS…', 50);
    const tiles = bboxToTiles(bbox, zoom);
    log(`Tuiles WMTS zoom ${zoom} dans la bbox : ${tiles.length}`, 'info');

    if (tiles.length > 2000) {
      log(`⚠ ${tiles.length} tuiles — cela peut prendre du temps et consommer de la mémoire.`, 'warn');
    }

    // ── ÉTAPE 5 : MBTiles ─────────────────────────────────────────
    setProgress('Assemblage MBTiles…', 55);
    log('Démarrage de l\'assemblage MBTiles…', 'info');

    const mbtData = await buildMBTiles(tiles, estranPoly, zoom, (done, total) => {
      const pct = 55 + 40 * (done / total);
      setProgress(`Tuiles : ${done}/${total}`, pct);
    });

    state.mbtData = mbtData;
    const sizeKo = (mbtData.byteLength / 1024).toFixed(1);
    const sizeMo = (mbtData.byteLength / 1024 / 1024).toFixed(2);

    // ── ÉTAPE 6 : Proposer le téléchargement ──────────────────────
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
