/* ═══════════════════════════════════════════════════════════════
   PLATIER_CL v1.6.0 — Application principale
   BernardHoyez.github.io/platier_cl
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTES ────────────────────────────────────────────────────
const IGN_ALTI_URL    = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_ALTI_RES    = 'ign_rge_alti_wld';
const IGN_WMTS_BASE   = 'https://data.geopf.fr/wmts';
const IGN_ORTHO_LAYER = 'ORTHOIMAGERY.ORTHOPHOTOS';

const ALTI_BATCH = 40;    // points max par requête IGN
const ALTI_DELAY = 220;   // ms entre requêtes (< 5 req/s)
const CONCUR     = 3;     // tuiles téléchargées en parallèle
const MIN_AREA   = 2000;  // m² minimum pour conserver un polygone
const SIMPLIFY   = 0.00004;

// ─── STATE ─────────────────────────────────────────────────────────
const S = { bbox:null, poly:null, mbt:null, abort:null, t0:Date.now() };

// ─── DOM ───────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const logEl   = $('logArea');
const fillEl  = $('progressFill');
const lblEl   = $('progressLabel');
const pctEl   = $('progressPct');
const statEl  = $('globalStatus');
const dlZone  = $('downloadZone');

// ─── LOG ───────────────────────────────────────────────────────────
function ts() {
  const s = Math.floor((Date.now()-S.t0)/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function log(msg, lv='info') {
  const d = document.createElement('div');
  d.className = 'log-line '+lv;
  d.innerHTML = `<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── PROGRESS ──────────────────────────────────────────────────────
// yield() libère le thread pour que le DOM se repeigne
const yield_ = () => new Promise(r => setTimeout(r, 0));

async function prog(label, pct) {
  lblEl.textContent  = label;
  pctEl.textContent  = Math.round(pct)+'%';
  fillEl.style.width = pct+'%';
  await yield_();   // ← force le repaint
}

function status(s) {
  const C = {idle:'chip-idle', run:'chip-running', done:'chip-done', err:'chip-error'};
  const L = {idle:'Prêt', run:'En cours…', done:'Terminé ✓', err:'Erreur'};
  statEl.className = 'status-chip '+(C[s]||'chip-idle');
  statEl.innerHTML = `<span class="dot"></span> ${L[s]||s}`;
}

// ─── CARTE ─────────────────────────────────────────────────────────
const map = L.map('map',{center:[47.5,-2.0],zoom:10});

L.tileLayer(
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {attribution:'© IGN Geoplateforme', maxZoom:18}
).addTo(map);

const orthoLyr = L.tileLayer(
  IGN_WMTS_BASE+'?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image/jpeg` +
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {maxZoom:20, opacity:0.65}
);

// Leaflet Draw
const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw:{ rectangle:{shapeOptions:{color:'#00c8a0',weight:2}},
         polygon:false,polyline:false,circle:false,circlemarker:false,marker:false },
  edit:{ featureGroup:drawn, remove:true }
}));

let estranLyr = null;

map.on(L.Draw.Event.CREATED, e => {
  drawn.clearLayers(); drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  S.bbox = {minLon:b.getWest(), minLat:b.getSouth(), maxLon:b.getEast(), maxLat:b.getNorth()};
  updateCoords();
  orthoLyr.addTo(map);
  map.fitBounds(b,{padding:[20,20]});
  log(`Zone : ${fmt(S.bbox.minLon)}, ${fmt(S.bbox.minLat)} → ${fmt(S.bbox.maxLon)}, ${fmt(S.bbox.maxLat)}`,'ok');
  enableUI(true);
});
map.on(L.Draw.Event.DELETED, () => { S.bbox=null; updateCoords(); enableUI(false); });

function fmt(v){ return Number(v).toFixed(4); }
function updateCoords(){
  const b=S.bbox;
  $('cLonMin').textContent = b?fmt(b.minLon):'—';
  $('cLonMax').textContent = b?fmt(b.maxLon):'—';
  $('cLatMin').textContent = b?fmt(b.minLat):'—';
  $('cLatMax').textContent = b?fmt(b.maxLat):'—';
}
function enableUI(on){
  $('btnClear').disabled   = !on;
  $('btnProcess').disabled = !on;
  ['step2title','step3title'].forEach(id =>
    $(id).classList.toggle('inactive',!on));
}

$('btnClear').addEventListener('click', ()=>{
  drawn.clearLayers();
  if(estranLyr){ map.removeLayer(estranLyr); estranLyr=null; }
  orthoLyr.remove();
  S.bbox=S.poly=S.mbt=null;
  dlZone.classList.remove('visible');
  updateCoords(); enableUI(false);
  prog('En attente',0); status('idle');
  log('Zone effacée.','warn');
});

// coords curseur
const infoEl = $('mapInfo');
map.on('mousemove', e=>{
  infoEl.style.display='block';
  infoEl.textContent=`${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;
});
map.on('mouseout', ()=>{ infoEl.style.display='none'; });

// ─── TUILES XYZ ────────────────────────────────────────────────────
function lon2x(lon,z){ return Math.floor((lon+180)/360*2**z); }
function lat2y(lat,z){ return Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*2**z); }

function bboxTiles(bbox,z){
  const x0=lon2x(bbox.minLon,z), x1=lon2x(bbox.maxLon,z);
  const y0=lat2y(bbox.maxLat,z), y1=lat2y(bbox.minLat,z);
  const list=[];
  for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) list.push({z,x,y});
  return list;
}

// bbox WGS84 d'une tuile XYZ
function tileBbox(x,y,z){
  function tile2lon(x,z){ return x/2**z*360-180; }
  function tile2lat(y,z){ const n=Math.PI-2*Math.PI*y/2**z; return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))); }
  return { minLon:tile2lon(x,z),   minLat:tile2lat(y+1,z),
           maxLon:tile2lon(x+1,z), maxLat:tile2lat(y,z) };
}

// ─── FETCH AVEC ABORT ──────────────────────────────────────────────
async function get(url){
  if(!S.abort||S.abort.signal.aborted) throw new Error('Annulé');
  const r = await fetch(url,{signal:S.abort.signal});
  if(!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0,90)}`);
  return r;
}

// ─── MNT IGN REST ──────────────────────────────────────────────────
async function fetchMNT(bbox, res){
  const latMid = (bbox.minLat+bbox.maxLat)/2;
  const dLon   = res / (111320*Math.cos(latMid*Math.PI/180));
  const dLat   = res / 111320;
  const MAXDIM = 80;  // 80×80 = 6400 pts = 160 req → ~40s
  const cols   = Math.min(MAXDIM, Math.ceil((bbox.maxLon-bbox.minLon)/dLon));
  const rows   = Math.min(MAXDIM, Math.ceil((bbox.maxLat-bbox.minLat)/dLat));
  const sLon   = (bbox.maxLon-bbox.minLon)/(cols-1||1);
  const sLat   = (bbox.maxLat-bbox.minLat)/(rows-1||1);

  // Construire liste de points
  const lons=[],lats=[];
  for(let r=0;r<rows;r++)
    for(let c=0;c<cols;c++){
      lons.push(bbox.minLon+c*sLon);
      lats.push(bbox.maxLat-r*sLat);  // ligne 0 = nord
    }

  const total = lons.length;
  const nReq  = Math.ceil(total/ALTI_BATCH);
  log(`Grille MNT ${cols}×${rows} = ${total} pts (${nReq} requêtes IGN)…`,'info');

  const grid = new Float32Array(total).fill(NaN);

  for(let i=0;i<total;i+=ALTI_BATCH){
    if(S.abort?.signal.aborted) throw new Error('Annulé');
    const bLons = lons.slice(i,i+ALTI_BATCH);
    const bLats = lats.slice(i,i+ALTI_BATCH);
    const url   = IGN_ALTI_URL+'?'+new URLSearchParams({
      lon:      bLons.map(v=>v.toFixed(6)).join('|'),
      lat:      bLats.map(v=>v.toFixed(6)).join('|'),
      resource: IGN_ALTI_RES,
      delimiter:'|', indent:'false', measures:'false', zonly:'false',
    });
    try {
      const resp = await get(url);
      const data = await resp.json();
      (data.elevations||[]).forEach((e,j)=>{
        const z = e.z;
        // IGN nodata = -99999 ; valeurs marines négatives légitimes sont conservées
        grid[i+j] = (z==null||z<=-99990) ? NaN : z;
      });
    } catch(e) {
      if(e.message==='Annulé') throw e;
      log(`Req altimétrie ${Math.floor(i/ALTI_BATCH)+1}/${nReq} échouée : ${e.message}`,'warn');
    }
    const pct = 5+25*(i+ALTI_BATCH)/total;
    await prog(`Altimétrie ${Math.min(i+ALTI_BATCH,total)}/${total} pts`, pct);
    if(i+ALTI_BATCH<total) await new Promise(r=>setTimeout(r,ALTI_DELAY));
  }

  // Stats
  let vmin=Infinity,vmax=-Infinity,cnt=0;
  for(const v of grid) if(!isNaN(v)){if(v<vmin)vmin=v;if(v>vmax)vmax=v;cnt++;}
  log(`MNT : ${cnt}/${total} pts valides — alt. ${isFinite(vmin)?vmin.toFixed(2):'?'} / ${isFinite(vmax)?vmax.toFixed(2):'?'} m NGF`,'ok');

  return {grid,cols,rows,bbox};
}

// ─── MASQUE ESTRAN (raster → vecteur) ──────────────────────────────
// 1) Masque binaire : 1 si pbme <= z <= pmve, OU si NaN entouré de 1 (bord de mer)
// 2) Marching squares sur ce masque
// 3) Assemblage en anneaux
// 4) GeoJSON + nettoyage

function buildMask(grid, cols, rows, pbme, pmve){
  // Passe 1 : masque strict
  const mask = new Uint8Array(cols*rows);
  for(let i=0;i<grid.length;i++){
    const v=grid[i];
    if(!isNaN(v) && v>=pbme && v<=pmve) mask[i]=1;
  }

  // Passe 2 : combler les NaN entourés de cellules estran (lacunes de couverture)
  // Un NaN en bordure de mer doit rejoindre l'estran si ses voisins valides sont ≤ pbme
  // (indique qu'on est côté mer ouverte = inclure dans l'estran)
  for(let r=1;r<rows-1;r++){
    for(let c=1;c<cols-1;c++){
      const i=r*cols+c;
      if(!isNaN(grid[i])) continue; // pas un NaN
      // Voisins
      const v=[grid[i-1],grid[i+1],grid[i-cols],grid[i+cols]].filter(x=>!isNaN(x));
      if(v.length===0) continue;
      // Si tous les voisins valides sont sous pbme (mer) → c'est de la mer, inclure
      if(v.every(x=>x<=pbme)) mask[i]=1;
    }
  }

  return mask;
}

function maskToGeoJSON(mask, cols, rows, bbox, pbme, pmve){
  // Marching squares sur le masque binaire
  const segs=[];
  for(let r=0;r<rows-1;r++){
    for(let c=0;c<cols-1;c++){
      const tl=mask[r*cols+c], tr=mask[r*cols+c+1];
      const bl=mask[(r+1)*cols+c], br=mask[(r+1)*cols+c+1];
      const idx=(tl<<3)|(tr<<2)|(br<<1)|bl;
      if(idx===0||idx===15) continue;
      const T=[c+.5,r], B=[c+.5,r+1], L=[c,r+.5], R=[c+1,r+.5];
      const tbl={
        1:[[L,B]], 2:[[B,R]], 3:[[L,R]], 4:[[T,R]],
        5:[[T,R],[B,L]], 6:[[T,B]], 7:[[T,L]],
        8:[[T,L]], 9:[[T,B]], 10:[[T,L],[B,R]],
        11:[[T,R]], 12:[[L,R]], 13:[[B,R]], 14:[[L,B]],
      };
      for(const s of (tbl[idx]||[])) segs.push(s);
    }
  }
  if(segs.length===0) return null;

  // px → WGS84
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const p2w=([px,py])=>[bbox.minLon+px*cW, bbox.maxLat-py*cH];
  const wsegs=segs.map(([a,b])=>[p2w(a),p2w(b)]);

  // Assembler en anneaux
  const rings=assembleRings(wsegs);
  if(rings.length===0) return null;
  log(`${rings.length} anneau(x) estran extraits`,'info');

  const polys=rings
    .filter(r=>r.length>=4)
    .map(r=>{ if(r[0][0]!==r[r.length-1][0]||r[0][1]!==r[r.length-1][1]) r.push(r[0]); return r; });
  if(polys.length===0) return null;

  const gj = polys.length===1
    ? turf.polygon([polys[0]])
    : turf.multiPolygon(polys.map(p=>[p]));

  // Simplifier + filtrer îlots
  const simp = turf.simplify(gj,{tolerance:SIMPLIFY,highQuality:false});
  return filterSmall(simp);
}

function assembleRings(segs){
  const eps=1e-9;
  const ptEq=([ax,ay],[bx,by])=>Math.abs(ax-bx)<eps&&Math.abs(ay-by)<eps;
  const used=new Uint8Array(segs.length);
  const rings=[];
  for(let s=0;s<segs.length;s++){
    if(used[s]) continue;
    used[s]=1;
    const ring=[...segs[s]];
    let changed=true;
    while(changed){
      changed=false;
      const tail=ring[ring.length-1];
      for(let j=0;j<segs.length;j++){
        if(used[j]) continue;
        if(ptEq(segs[j][0],tail)){ ring.push(segs[j][1]); used[j]=1; changed=true; break; }
        if(ptEq(segs[j][1],tail)){ ring.push(segs[j][0]); used[j]=1; changed=true; break; }
      }
    }
    if(ring.length>=4) rings.push(ring);
  }
  return rings;
}

function filterSmall(gj){
  if(!gj) return null;
  if(gj.geometry.type==='Polygon'){
    return turf.area(gj)>=MIN_AREA ? gj : null;
  }
  if(gj.geometry.type==='MultiPolygon'){
    const kept=gj.geometry.coordinates.filter(c=>turf.area(turf.polygon(c))>=MIN_AREA);
    if(kept.length===0) return null;
    if(kept.length===1) return turf.polygon(kept[0]);
    return turf.multiPolygon(kept);
  }
  return gj;
}

// ─── INTERSECT TUILE / POLYGONE ─────────────────────────────────────
// On utilise une bbox check simple puis Turf, avec fallback sur bbox seule
// pour éviter les faux-négatifs de booleanIntersects sur MultiPolygon
function tileIntersects(tile, poly){
  const tb = tileBbox(tile.x,tile.y,tile.z);
  // 1. Test bbox rapide contre l'enveloppe du polygone
  const pb = turf.bbox(poly); // [minLon,minLat,maxLon,maxLat]
  if(tb.maxLon<pb[0]||tb.minLon>pb[2]||tb.maxLat<pb[1]||tb.minLat>pb[3]) return false;
  // 2. Test précis
  try{
    const tBox = turf.bboxPolygon([tb.minLon,tb.minLat,tb.maxLon,tb.maxLat]);
    // booleanIntersects peut rater sur MultiPolygon → on décompose
    if(poly.geometry.type==='MultiPolygon'){
      return poly.geometry.coordinates.some(c=>{
        try{ return turf.booleanIntersects(turf.polygon(c), tBox); }catch{ return false; }
      });
    }
    return turf.booleanIntersects(poly, tBox);
  }catch{ return true; } // en cas d'erreur Turf, on inclut la tuile
}

// ─── ORTHO TILE FETCH ──────────────────────────────────────────────
async function fetchTile(z,x,y){
  const url=IGN_WMTS_BASE+
    `?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`+
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image/jpeg`+
    `&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  const r=await get(url);
  return new Uint8Array(await r.arrayBuffer());
}

// ─── MBTILES ───────────────────────────────────────────────────────
async function buildMBTiles(tiles, zoom){
  await prog('Initialisation SQLite…', 56);
  log('Initialisation sql.js (SQLite WASM)…','info');

  const SQL = await initSqlJs({
    locateFile: f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });
  const db = new SQL.Database();

  db.run('CREATE TABLE metadata (name TEXT, value TEXT)');
  db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY(zoom_level,tile_column,tile_row))');
  db.run('CREATE UNIQUE INDEX tile_idx ON tiles(zoom_level,tile_column,tile_row)');

  for(const [k,v] of [
    ['name','Estran Platier CL'],['type','baselayer'],['version','1.0'],
    ['description','BD Ortho IGN — zone estran'],['format','jpg'],
    ['minzoom',String(zoom)],['maxzoom',String(zoom)],
  ]) db.run('INSERT INTO metadata VALUES(?,?)',[k,v]);

  const stmt = db.prepare('INSERT OR REPLACE INTO tiles VALUES(?,?,?,?)');
  const total = tiles.length;
  let done=0, errors=0;

  for(let i=0;i<total;i+=CONCUR){
    if(S.abort?.signal.aborted) throw new Error('Annulé');

    const batch = tiles.slice(i,i+CONCUR);
    const res   = await Promise.allSettled(batch.map(t=>fetchTile(t.z,t.x,t.y)));

    for(let j=0;j<batch.length;j++){
      done++;
      if(res[j].status==='fulfilled'){
        const {z,x,y}=batch[j];
        const tmsY=2**z-1-y;  // TMS = Y inversé
        stmt.run([z,x,tmsY,res[j].value]);
      } else {
        errors++;
        log(`⚠ Tuile ${batch[j].z}/${batch[j].x}/${batch[j].y} : ${res[j].reason?.message||'erreur'}`,'warn');
      }
    }

    const pct = 58+40*(done/total);
    await prog(`Tuiles ortho : ${done}/${total}  (${errors} erreur(s))`, pct);
  }

  stmt.free();
  log('Export SQLite…','info');
  await prog('Export SQLite…', 99);
  const data = db.export();
  db.close();

  if(!data||data.byteLength<4096) throw new Error('Fichier SQLite trop petit — aucune tuile insérée ?');
  return data;
}

// ─── TÉLÉCHARGEMENT ────────────────────────────────────────────────
function download(data){
  try{
    const blob = new Blob([data.buffer], {type:'application/x-sqlite3'});
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'),{href:url,download:'estran.mbtiles'});
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),15000);
    log('Téléchargement déclenché : estran.mbtiles','ok');
  }catch(e){ log('Erreur téléchargement : '+e.message,'err'); }
}

$('btnDownload').addEventListener('click',()=>{
  if(S.mbt) download(S.mbt);
  else log('Aucun fichier disponible.','warn');
});

// ─── PIPELINE ──────────────────────────────────────────────────────
async function run(){
  if(!S.bbox){ log('Aucune zone sélectionnée.','warn'); return; }

  S.t0=Date.now(); S.abort=new AbortController();
  $('btnProcess').disabled=true;
  $('btnAbort').disabled=false;
  dlZone.classList.remove('visible');
  status('run');

  const pbme = isNaN(parseFloat($('pbmeAlt').value)) ? -3.0 : parseFloat($('pbmeAlt').value);
  const pmve = isNaN(parseFloat($('pmveAlt').value)) ?  5.0 : parseFloat($('pmveAlt').value);
  const res  = parseInt($('mntRes').value)   || 5;
  const zoom = parseInt($('orthoZoom').value)|| 18;

  log(`▶ Démarrage — basse=${pbme}m, PMVE=${pmve}m, résol=${res}m, zoom=${zoom}`,'info');

  try{
    // ── 1. MNT altimétrique ──────────────────────────────────────
    await prog('Téléchargement altimétrie IGN…', 5);
    const {grid,cols,rows,bbox} = await fetchMNT(S.bbox, res);

    // ── 2. Masque estran ─────────────────────────────────────────
    await prog('Construction masque estran…', 32);
    log(`Masque estran [${pbme} m – ${pmve} m NGF]…`,'info');
    const mask = buildMask(grid, cols, rows, pbme, pmve);
    const nCells = mask.reduce((a,v)=>a+v,0);
    log(`${nCells}/${cols*rows} cellules dans la plage estran`,'info');

    if(nCells===0) throw new Error(
      `Aucune cellule estran trouvée entre ${pbme} m et ${pmve} m NGF. `+
      `Vérifiez les altitudes et la zone (elle doit être littorale).`
    );

    // ── 3. Polygone vectoriel ────────────────────────────────────
    await prog('Vectorisation du masque…', 38);
    log('Vectorisation + nettoyage…','info');
    const poly = maskToGeoJSON(mask, cols, rows, bbox, pbme, pmve);

    if(!poly) throw new Error('Impossible de construire le polygone estran — essayez une zone plus grande ou des altitudes différentes.');

    S.poly = poly;
    const ha = (turf.area(poly)/10000).toFixed(1);
    log(`Polygone estran : ${ha} ha`,'ok');

    if(estranLyr) map.removeLayer(estranLyr);
    estranLyr = L.geoJSON(poly,{
      style:{color:'#00c8a0',weight:2,fillColor:'#00c8a0',fillOpacity:0.22}
    }).addTo(map);

    // ── 4. Sélection tuiles ──────────────────────────────────────
    await prog('Sélection des tuiles ortho…', 45);
    const allTiles = bboxTiles(bbox, zoom);
    log(`Tuiles bbox zoom ${zoom} : ${allTiles.length} — filtrage sur estran…`,'info');

    const selTiles = allTiles.filter(t => tileIntersects(t, poly));
    log(`Tuiles retenues : ${selTiles.length} / ${allTiles.length}`,'ok');

    if(selTiles.length===0) throw new Error('Aucune tuile ne couvre le polygone estran.');
    if(selTiles.length>4000) log(`⚠ ${selTiles.length} tuiles : opération longue, soyez patient.`,'warn');

    // ── 5. MBTiles ───────────────────────────────────────────────
    await prog('Démarrage assemblage MBTiles…', 55);
    const mbt = await buildMBTiles(selTiles, zoom);
    S.mbt = mbt;

    const sz = mbt.byteLength>1048576
      ? `${(mbt.byteLength/1048576).toFixed(2)} Mo`
      : `${(mbt.byteLength/1024).toFixed(0)} Ko`;
    log(`MBTiles : ${sz} — ${selTiles.length} tuiles zoom ${zoom}`,'ok');

    // ── 6. Téléchargement auto ───────────────────────────────────
    await prog('Téléchargement…', 99);
    download(mbt);
    await prog('✓ Terminé', 100);
    status('done');

    $('mbtSize').textContent = sz;
    dlZone.classList.add('visible');
    log('✓ Pipeline terminé.','ok');

  }catch(e){
    if(e.name==='AbortError'||e.message==='Annulé'){
      log('Annulé.','warn'); status('idle'); await prog('Annulé',0);
    } else {
      log('ERREUR : '+e.message,'err');
      console.error(e);
      status('err'); await prog('Erreur',0);
    }
  } finally {
    $('btnProcess').disabled=false;
    $('btnAbort').disabled=true;
    S.abort=null;
  }
}

$('btnProcess').addEventListener('click', run);
$('btnAbort').addEventListener('click', ()=>{
  if(S.abort){ S.abort.abort(); log('Annulation demandée…','warn'); }
});

log('Platier CL prêt. Dessinez un rectangle sur la carte.','ok');
