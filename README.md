# Platier CL

**PWA d'extraction d'estran** à partir des données IGN Geoplateforme et SHOM.

🌐 **URL de déploiement** : `https://BernardHoyez.github.io/platier_cl`

---

## Fonctionnalités

1. **Sélection de zone** — Rectangle dessiné à la souris sur carte IGN Plan
2. **Extraction estran** — Isocontours 0 m NGF et PMVE (RGE Alti IGN WCS)
3. **Nettoyage géométrique** — Suppression des îlots < 5 000 m²
4. **Assemblage MBTiles** — Toutes les orthophotos IGN (BD Ortho) de la zone estran
5. **Export** — Fichier `estran.mbtiles` téléchargeable directement

---

## Architecture technique

| Composant | Source | Protocole |
|-----------|--------|-----------|
| MNT altimétrique | IGN RGE Alti | WCS 2.0 (`ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES`) |
| Orthophotos | IGN BD Ortho | WMTS (`ORTHOIMAGERY.ORTHOPHOTOS`) |
| PMVE locales | SHOM | Paramètre utilisateur (à affiner avec WFS SHOM) |
| Fond de carte | IGN Plan V2 | WMTS |

---

## Déploiement sur GitHub Pages

### Prérequis
- Repo : `BernardHoyez/platier_cl`
- Branch principale : `main`

### Étapes

```bash
git clone https://github.com/BernardHoyez/platier_cl.git
# Copier les fichiers dans le repo
git add .
git commit -m "Initial Platier CL PWA"
git push origin main
```

Puis dans **Settings → Pages** :
- Source : **GitHub Actions**

Le workflow `.github/workflows/deploy.yml` déploie automatiquement à chaque push.

### Mise à jour du cache SW

Pour invalider le cache de tous les clients, incrémenter `CACHE_VERSION` dans `sw.js` :

```js
const CACHE_VERSION = 'platier-v1.0.1'; // ← changer à chaque release
```

---

## Icônes

Les fichiers `icon192.png` et `icon512.png` sont des placeholders.  
Remplacez-les par vos icônes définitives (même dimensions, fond transparent conseillé).

---

## Limitations connues

- **GeoTIFF IGN** : le parser interne supporte Float32 non compressé (LZW/Deflate à venir).  
  Pour les zones avec compression, utiliser la résolution 25 m qui retourne généralement un TIFF non compressé.
- **Mémoire** : pour les zones > 500 tuiles zoom 18, privilégier zoom 17 ou 16.
- **CORS** : les API IGN Geoplateforme autorisent les requêtes depuis le navigateur sans clé API.
- **SHOM PMVE** : les données PMVE sont saisies manuellement. Une intégration WFS SHOM est prévue.

---

## Licence

Usage personnel — données © IGN Geoplateforme, © SHOM
