/* ═══════════════════════════════════════════════════════════════
   PLATIER_CL v2.0.0 — réécriture complète
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
const IGN_ALTI  = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_WMTS  = 'https://data.geopf.fr/wmts';
const ORTHO_LYR = 'ORTHOIMAGERY.ORTHOPHOTOS';
const ALTI_RES  = 'ign_rge_alti_wld';
const BATCH     = 40;    // pts/req IGN
const DELAY_MS  = 230;   // pause entre requêtes alti
const CONCUR    = 3;     // tuiles parallèles
const MIN_AREA  = 1000;  // m² min polygone estran
const SIMP_TOL  = 0.00004;

// ── STATE ──────────────────────────────────────────────────────────
const ST = {
  bbox : null,
  poly : null,
  mbt  : null,
  ac   : null,   // AbortController
  t0   : Date.now()
};

// ── DOM ────────────────────────────────────────────────────────────
const $      = id => document.getElementById(id);
const logEl  = $('logArea');
const barEl  = $('progressFill');
const lblEl  = $('progressLabel');
const pctEl  = $('progressPct');
const statEl = $('globalStatus');
const dlEl   = $('downloadZone');

// ── HORLOGE ────────────────────────────────────────────────────────
function ts(){
  const s=Math.floor((Date.now()-ST.t0)/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}

// ── LOG ────────────────────────────────────────────────────────────
function log(msg,lv='info'){
  const d=document.createElement('div');
  d.className='log-line '+lv;
  d.innerHTML=`<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  logEl.appendChild(d);
  logEl.scrollTop=logEl.scrollHeight;
}

// ── PROGRESSION ────────────────────────────────────────────────────
// Chaque appel à prog() force un repaint via Promise/setTimeout
function prog(label, pct){
  lblEl.textContent  = label;
  pctEl.textContent  = Math.round(pct)+'%';
  barEl.style.width  = Math.min(100,pct)+'%';
  // Forcer repaint : retourner une microtâche + une macrotâche
  return new Promise(res => setTimeout(res, 4));
}

// ── STATUS ─────────────────────────────────────────────────────────
function setStatus(s){
  const CL={idle:'chip-idle',run:'chip-running',done:'chip-done',err:'chip-error'};
  const LB={idle:'Prêt',run:'En cours…',done:'Terminé ✓',err:'Erreur'};
  statEl.className='status-chip '+(CL[s]||'chip-idle');
  statEl.innerHTML=`<span class="dot"></span>${LB[s]||s}`;
}

// ── CARTE LEAFLET ──────────────────────────────────────────────────
const map=L.map('map',{center:[47.5,-2.0],zoom:10});

L.tileLayer(
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'+
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png'+
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {attribution:'© IGN',maxZoom:19}
).addTo(map);

const orthoLyr=L.tileLayer(
  IGN_WMTS+'?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'+
  `&LAYER=${ORTHO_LYR}&STYLE=normal&FORMAT=image/jpeg`+
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {maxZoom:20,opacity:0.65}
);

const drawn=new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw:{rectangle:{shapeOptions:{color:'#00c8a0',weight:2}},
        polygon:false,polyline:false,circle:false,circlemarker:false,marker:false},
  edit:{featureGroup:drawn,remove:true}
}));

let estranLyr=null;

map.on(L.Draw.Event.CREATED,e=>{
  drawn.clearLayers(); drawn.addLayer(e.layer);
  const b=e.layer.getBounds();
  ST.bbox={minLon:b.getWest(),minLat:b.getSouth(),maxLon:b.getEast(),maxLat:b.getNorth()};
  updateCoords();
  orthoLyr.addTo(map);
  map.fitBounds(b,{padding:[20,20]});
  log(`Zone : [${ST.bbox.minLon.toFixed(4)}, ${ST.bbox.minLat.toFixed(4)}] → [${ST.bbox.maxLon.toFixed(4)}, ${ST.bbox.maxLat.toFixed(4)}]`,'ok');
  uiEnable(true);
});
map.on(L.Draw.Event.DELETED,()=>{ST.bbox=null;updateCoords();uiEnable(false);});

function updateCoords(){
  const b=ST.bbox;
  $('cLonMin').textContent=b?b.minLon.toFixed(4):'—';
  $('cLonMax').textContent=b?b.maxLon.toFixed(4):'—';
  $('cLatMin').textContent=b?b.minLat.toFixed(4):'—';
  $('cLatMax').textContent=b?b.maxLat.toFixed(4):'—';
}
function uiEnable(on){
  $('btnClear').disabled=!on;
  $('btnProcess').disabled=!on;
  ['step2title','step3title'].forEach(id=>$(id).classList.toggle('inactive',!on));
}

$('btnClear').addEventListener('click',()=>{
  drawn.clearLayers();
  if(estranLyr){map.removeLayer(estranLyr);estranLyr=null;}
  orthoLyr.remove();
  ST.bbox=ST.poly=ST.mbt=null;
  dlEl.classList.remove('visible');
  updateCoords(); uiEnable(false);
  prog('En attente',0); setStatus('idle');
  log('Zone effacée.','warn');
});

const mapInfo=$('mapInfo');
map.on('mousemove',e=>{
  mapInfo.style.display='block';
  mapInfo.textContent=`${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;
});
map.on('mouseout',()=>{mapInfo.style.display='none';});

// ── TUILES XYZ ─────────────────────────────────────────────────────
const lon2x=(lon,z)=>Math.floor((lon+180)/360*(1<<z));
const lat2y=(lat,z)=>Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*(1<<z));

function bboxToTileList(bbox,z){
  const x0=lon2x(bbox.minLon,z), x1=lon2x(bbox.maxLon,z);
  const y0=lat2y(bbox.maxLat,z), y1=lat2y(bbox.minLat,z);
  const out=[];
  for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) out.push({z,x,y});
  return out;
}

// Renvoie la bbox WGS84 [W,S,E,N] d'une tuile
function tileWGS(x,y,z){
  const n=(1<<z);
  const w=x/n*360-180;
  const e=(x+1)/n*360-180;
  const lat1=Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI;
  const lat2=Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/n)))*180/Math.PI;
  return [w, Math.min(lat1,lat2), e, Math.max(lat1,lat2)];
}

// ── FETCH AVEC ABORT ───────────────────────────────────────────────
async function apiFetch(url){
  if(!ST.ac||ST.ac.signal.aborted) throw new Error('Annulé');
  const r=await fetch(url,{signal:ST.ac.signal});
  if(!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0,80)}`);
  return r;
}

// ── MNT IGN REST ───────────────────────────────────────────────────
async function getMNT(bbox,res){
  const latM=(bbox.minLat+bbox.maxLat)/2;
  const dLon=res/(111320*Math.cos(latM*Math.PI/180));
  const dLat=res/111320;
  const MAXD=80;
  const cols=Math.min(MAXD,Math.max(2,Math.round((bbox.maxLon-bbox.minLon)/dLon)+1));
  const rows=Math.min(MAXD,Math.max(2,Math.round((bbox.maxLat-bbox.minLat)/dLat)+1));
  const sLon=(bbox.maxLon-bbox.minLon)/(cols-1);
  const sLat=(bbox.maxLat-bbox.minLat)/(rows-1);
  const total=cols*rows;
  const nReq=Math.ceil(total/BATCH);

  log(`Grille MNT ${cols}×${rows} pts — ${nReq} requêtes IGN alti`,'info');
  await prog(`Altimétrie 0/${total} pts`,5);

  const grid=new Float32Array(total).fill(NaN);
  let fetched=0;

  for(let i=0;i<total;i+=BATCH){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const sz=Math.min(BATCH,total-i);
    const lons=[],lats=[];
    for(let j=0;j<sz;j++){
      const idx=i+j;
      const c=idx%cols, r=Math.floor(idx/cols);
      lons.push(bbox.minLon+c*sLon);
      lats.push(bbox.maxLat-r*sLat);   // ligne 0 = nord
    }
    const url=IGN_ALTI+'?'+new URLSearchParams({
      lon:lons.map(v=>v.toFixed(6)).join('|'),
      lat:lats.map(v=>v.toFixed(6)).join('|'),
      resource:ALTI_RES,delimiter:'|',indent:'false',measures:'false',zonly:'false'
    });
    try{
      const d=await (await apiFetch(url)).json();
      (d.elevations||[]).forEach((e,j)=>{
        const z=e.z;
        grid[i+j]=(z==null||z<=-99990)?NaN:Number(z);
      });
    }catch(e){
      if(e.message==='Annulé') throw e;
      log(`Req ${Math.ceil(i/BATCH)+1}/${nReq} échouée : ${e.message}`,'warn');
    }
    fetched+=sz;
    await prog(`Altimétrie ${fetched}/${total} pts`, 5+25*(fetched/total));
    if(i+BATCH<total) await new Promise(r=>setTimeout(r,DELAY_MS));
  }

  let vmin=Infinity,vmax=-Infinity,nv=0;
  for(const v of grid) if(!isNaN(v)){if(v<vmin)vmin=v;if(v>vmax)vmax=v;nv++;}
  log(`MNT reçu : ${nv}/${total} pts valides — alt. ${isFinite(vmin)?vmin.toFixed(2):'?'} / ${isFinite(vmax)?vmax.toFixed(2):'?'} m NGF`,'ok');

  return {grid,cols,rows};
}

// ── MASQUE BINAIRE ─────────────────────────────────────────────────
// Cellule = 1 si  pbme <= z <= pmve
// NaN côté mer (voisins tous < pbme) → aussi inclus
function makeMask(grid,cols,rows,pbme,pmve){
  const m=new Uint8Array(cols*rows);

  // Passe 1 : plage stricte
  for(let i=0;i<grid.length;i++){
    const v=grid[i];
    if(!isNaN(v)&&v>=pbme&&v<=pmve) m[i]=1;
  }

  // Passe 2 : NaN entourés uniquement de valeurs ≤ pbme → mer ouverte → inclure
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const i=r*cols+c;
      if(!isNaN(grid[i])) continue;
      const nb=[];
      if(c>0)      nb.push(grid[i-1]);
      if(c<cols-1) nb.push(grid[i+1]);
      if(r>0)      nb.push(grid[i-cols]);
      if(r<rows-1) nb.push(grid[i+cols]);
      const valid=nb.filter(x=>!isNaN(x));
      if(valid.length>0&&valid.every(x=>x<=pbme)) m[i]=1;
    }
  }

  return m;
}

// ── MARCHING SQUARES → SEGMENTS WGS84 ─────────────────────────────
function maskToSegs(mask,cols,rows,bbox){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const p2w=([px,py])=>[bbox.minLon+px*cW, bbox.maxLat-py*cH];

  const segs=[];
  for(let r=0;r<rows-1;r++){
    for(let c=0;c<cols-1;c++){
      const tl=mask[r*cols+c],     tr=mask[r*cols+c+1];
      const bl=mask[(r+1)*cols+c], br=mask[(r+1)*cols+c+1];
      const idx=(tl<<3)|(tr<<2)|(br<<1)|bl;
      if(idx===0||idx===15) continue;
      const T=[c+.5,r], B=[c+.5,r+1], L=[c,r+.5], R=[c+1,r+.5];
      const T_={1:[[L,B]],2:[[B,R]],3:[[L,R]],4:[[T,R]],
                5:[[T,R],[B,L]],6:[[T,B]],7:[[T,L]],
                8:[[T,L]],9:[[T,B]],10:[[T,L],[B,R]],
                11:[[T,R]],12:[[L,R]],13:[[B,R]],14:[[L,B]]};
      for(const s of (T_[idx]||[])) segs.push([p2w(s[0]),p2w(s[1])]);
    }
  }
  return segs;
}

// ── ASSEMBLER SEGMENTS → ANNEAUX ───────────────────────────────────
function assembleRings(segs){
  if(!segs.length) return [];
  const EPS=1e-9;
  const eq=([ax,ay],[bx,by])=>Math.abs(ax-bx)<EPS&&Math.abs(ay-by)<EPS;
  const used=new Uint8Array(segs.length);
  const rings=[];

  for(let s=0;s<segs.length;s++){
    if(used[s]) continue;
    used[s]=1;
    const ring=[segs[s][0],segs[s][1]];
    let go=true;
    while(go){
      go=false;
      const tail=ring[ring.length-1];
      for(let j=0;j<segs.length;j++){
        if(used[j]) continue;
        if(eq(segs[j][0],tail)){ring.push(segs[j][1]);used[j]=1;go=true;break;}
        if(eq(segs[j][1],tail)){ring.push(segs[j][0]);used[j]=1;go=true;break;}
      }
    }
    if(ring.length>=4) rings.push(ring);
  }
  return rings;
}

// ── MASQUE → GEOJSON ───────────────────────────────────────────────
function maskToGeoJSON(mask,cols,rows,bbox){
  const segs=maskToSegs(mask,cols,rows,bbox);
  if(!segs.length) return null;
  const rings=assembleRings(segs);
  if(!rings.length) return null;

  log(`${rings.length} anneau(x) extraits`,'info');

  // Fermer chaque anneau
  const closed=rings.map(r=>{
    const rr=[...r];
    if(!eq2(rr[0],rr[rr.length-1])) rr.push(rr[0]);
    return rr;
  }).filter(r=>r.length>=4);

  if(!closed.length) return null;

  const gj = closed.length===1
    ? turf.polygon([closed[0]])
    : turf.multiPolygon(closed.map(r=>[r]));

  // Simplifier
  let simp;
  try{ simp=turf.simplify(gj,{tolerance:SIMP_TOL,highQuality:false}); }
  catch{ simp=gj; }

  // Filtrer les petits polygones
  return dropSmall(simp);
}

function eq2(a,b){ return Math.abs(a[0]-b[0])<1e-9&&Math.abs(a[1]-b[1])<1e-9; }

function dropSmall(gj){
  if(!gj) return null;
  const t=gj.geometry.type;
  if(t==='Polygon') return turf.area(gj)>=MIN_AREA?gj:null;
  if(t==='MultiPolygon'){
    const ok=gj.geometry.coordinates.filter(c=>turf.area(turf.polygon(c))>=MIN_AREA);
    if(!ok.length) return null;
    return ok.length===1?turf.polygon(ok[0]):turf.multiPolygon(ok);
  }
  return gj;
}

// ── TEST INTERSECTION TUILE / POLYGONE ─────────────────────────────
// Approche raster : on vérifie directement sur le masque
// si une tuile contient au moins 1 cellule estran.
// C'est plus fiable que booleanIntersects sur MultiPolygon.
function tilesFromMask(mask,cols,rows,bbox,zoom){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;

  const tileSet=new Set();
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(!mask[r*cols+c]) continue;
      // Centre de la cellule en WGS84
      const lon=bbox.minLon+(c+0.5)*cW;
      const lat=bbox.maxLat-(r+0.5)*cH;
      const tx=lon2x(lon,zoom);
      const ty=lat2y(lat,zoom);
      tileSet.add(`${zoom}/${tx}/${ty}`);
      // Aussi les 8 voisins pour éviter les coutures
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        if(dx||dy) tileSet.add(`${zoom}/${tx+dx}/${ty+dy}`);
      }
    }
  }

  return [...tileSet].map(k=>{
    const[z,x,y]=k.split('/').map(Number);
    return {z,x,y};
  });
}

// ── FETCH TUILE ORTHO ──────────────────────────────────────────────
async function fetchTile(z,x,y){
  const url=IGN_WMTS+
    `?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`+
    `&LAYER=${ORTHO_LYR}&STYLE=normal&FORMAT=image/jpeg`+
    `&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  const r=await apiFetch(url);
  return new Uint8Array(await r.arrayBuffer());
}

// ── CONSTRUIRE MBTILES ─────────────────────────────────────────────
async function buildMBT(tiles,zoom){
  await prog('Chargement sql.js…',57);
  log(`sql.js : chargement SQLite WASM…`,'info');

  const SQL=await initSqlJs({
    locateFile:f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });
  const db=new SQL.Database();

  db.run('CREATE TABLE metadata(name TEXT,value TEXT)');
  db.run('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row))');
  db.run('CREATE UNIQUE INDEX tidx ON tiles(zoom_level,tile_column,tile_row)');

  for(const[k,v]of[
    ['name','Estran Platier CL'],['type','baselayer'],['version','1'],
    ['description','BD Ortho IGN — estran'],['format','jpg'],
    ['minzoom',String(zoom)],['maxzoom',String(zoom)],
  ]) db.run('INSERT INTO metadata VALUES(?,?)',[k,v]);

  const ins=db.prepare('INSERT OR REPLACE INTO tiles VALUES(?,?,?,?)');
  const total=tiles.length;
  let done=0,errs=0;

  log(`Téléchargement ${total} tuiles zoom ${zoom}…`,'info');

  for(let i=0;i<total;i+=CONCUR){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const batch=tiles.slice(i,i+CONCUR);
    const res=await Promise.allSettled(batch.map(t=>fetchTile(t.z,t.x,t.y)));
    for(let j=0;j<batch.length;j++){
      done++;
      if(res[j].status==='fulfilled'){
        const{z,x,y}=batch[j];
        ins.run([z,x,(1<<z)-1-y,res[j].value]);  // TMS : Y inversé
      } else {
        errs++;
        log(`✗ ${batch[j].z}/${batch[j].x}/${batch[j].y} : ${res[j].reason?.message}`,'warn');
      }
    }
    await prog(`Tuiles ${done}/${total}${errs?` (${errs} erreurs)`:''}`, 58+40*(done/total));
  }

  ins.free();
  log(`Export SQLite (${done-errs} tuiles insérées)…`,'info');
  await prog('Export SQLite…',99);

  const data=db.export();
  db.close();
  if(!data||data.byteLength<512) throw new Error('Export SQLite vide.');
  return data;
}

// ── DÉCLENCHER TÉLÉCHARGEMENT ──────────────────────────────────────
function triggerDL(data){
  try{
    // data est un Uint8Array — on passe data.buffer (ArrayBuffer)
    const blob=new Blob([data.buffer],{type:'application/x-sqlite3'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='estran.mbtiles';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    log('⬇ Téléchargement estran.mbtiles déclenché','ok');
  }catch(e){
    log('Erreur téléchargement : '+e.message,'err');
    console.error(e);
  }
}

$('btnDownload').addEventListener('click',()=>{
  if(ST.mbt) triggerDL(ST.mbt);
  else log('Aucun fichier MBTiles disponible.','warn');
});

// ── PIPELINE PRINCIPAL ─────────────────────────────────────────────
async function run(){
  if(!ST.bbox){log('Aucune zone sélectionnée.','warn');return;}

  ST.t0=Date.now();
  ST.ac=new AbortController();
  $('btnProcess').disabled=true;
  $('btnAbort').disabled=false;
  dlEl.classList.remove('visible');
  setStatus('run');

  const pbme=isNaN(parseFloat($('pbmeAlt')?.value))?-3:parseFloat($('pbmeAlt').value);
  const pmve=isNaN(parseFloat($('pmveAlt')?.value))? 5:parseFloat($('pmveAlt').value);
  const res =parseInt($('mntRes')?.value)||5;
  const zoom=parseInt($('orthoZoom')?.value)||18;

  log(`▶ basse=${pbme}m  PMVE=${pmve}m  résol=${res}m  zoom=${zoom}`,'info');

  try{

    // 1. ALTIMÉTRIE
    await prog('Téléchargement altimétrie IGN…',5);
    const{grid,cols,rows}=await getMNT(ST.bbox,res);

    // 2. MASQUE
    await prog('Construction masque estran…',32);
    const mask=makeMask(grid,cols,rows,pbme,pmve);
    const nCells=mask.reduce((s,v)=>s+v,0);
    log(`Masque : ${nCells}/${cols*rows} cellules estran`,'info');
    if(!nCells) throw new Error(
      `Aucune cellule entre ${pbme} m et ${pmve} m NGF. Vérifiez les seuils et la zone.`);

    // 3. POLYGONE
    await prog('Vectorisation…',36);
    const poly=maskToGeoJSON(mask,cols,rows,ST.bbox);
    if(!poly) throw new Error('Vectorisation échouée — essayez une zone plus grande.');
    ST.poly=poly;
    const ha=(turf.area(poly)/10000).toFixed(1);
    log(`Polygone estran : ${ha} ha`,'ok');
    if(estranLyr) map.removeLayer(estranLyr);
    estranLyr=L.geoJSON(poly,{
      style:{color:'#00c8a0',weight:2,fillColor:'#00c8a0',fillOpacity:0.22}
    }).addTo(map);

    // 4. TUILES (depuis masque raster — plus fiable que Turf booleanIntersects)
    await prog('Sélection tuiles ortho…',45);
    const tiles=tilesFromMask(mask,cols,rows,ST.bbox,zoom);
    log(`Tuiles sélectionnées (masque) : ${tiles.length}`,'ok');
    if(!tiles.length) throw new Error('Aucune tuile à télécharger.');
    if(tiles.length>5000) log(`⚠ ${tiles.length} tuiles — peut être long.`,'warn');

    // 5. MBTILES
    await prog('Démarrage assemblage MBTiles…',55);
    const mbt=await buildMBT(tiles,zoom);
    ST.mbt=mbt;
    const sz=mbt.byteLength>1048576
      ?`${(mbt.byteLength/1048576).toFixed(2)} Mo`
      :`${(mbt.byteLength/1024).toFixed(0)} Ko`;
    log(`MBTiles : ${sz}`,'ok');

    // 6. TÉLÉCHARGEMENT AUTOMATIQUE
    await prog('Téléchargement automatique…',99);
    triggerDL(mbt);
    await prog('✓ Terminé',100);
    setStatus('done');
    $('mbtSize').textContent=sz;
    dlEl.classList.add('visible');
    log('✓ Terminé. Cliquez à nouveau sur le bouton si le téléchargement n\'a pas démarré.','ok');

  }catch(e){
    if(e.name==='AbortError'||e.message==='Annulé'){
      log('Annulé.','warn'); setStatus('idle'); await prog('Annulé',0);
    }else{
      log('ERREUR : '+e.message,'err');
      console.error('[Platier]',e);
      setStatus('err'); await prog('Erreur',0);
    }
  }finally{
    $('btnProcess').disabled=false;
    $('btnAbort').disabled=true;
    ST.ac=null;
  }
}

$('btnProcess').addEventListener('click',run);
$('btnAbort').addEventListener('click',()=>{if(ST.ac){ST.ac.abort();log('Annulation…','warn');}});

log('Platier CL v2.0 prêt. Dessinez un rectangle sur la carte.','ok');
