"""IMANTAU — prepare real geodata for the Blender scene (Python 3 + numpy + Pillow).

    python tools/geo_prepare.py

Inputs (work/geo/, downloaded by tools/geo_fetch.sh):
  dem_z13.npy      Terrarium elevation tiles (AWS Terrain Tiles, SRTM-based), metres, z13
  sat_z14.jpg      Sentinel-2 cloudless 2016 by EOX (CC BY 4.0), z14 mosaic
  raw/osm.json     OpenStreetMap: water, buildings, roads (ODbL)
  raw/osm_places.json  OpenStreetMap: places, waterways, peaks (optional)
  bounds.json      geographic bounds of the mosaic
Outputs (work/geo/prepared/): height.npy, texture.png, trees.npy, scene.json
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
G = ROOT / 'work' / 'geo'; OUT = G / 'prepared'; OUT.mkdir(exist_ok=True)
X0T, Y0T, Z = 11292, 5330, 14               # z14 tile origin of the mosaic
SAT_W, SAT_H = 15 * 256, 16 * 256
UNIT = 40.0                                 # metres per scene unit
VE = 2.5                                    # vertical exaggeration (stated on the site)
DEM_STEP = 4                                # mesh vertex every 4 DEM pixels (~46 m)

b = json.loads((G / 'bounds.json').read_text())
lat0 = (b['north'] + b['south']) / 2
MPP = 156543.03392 / 2 ** Z * math.cos(math.radians(lat0))   # ground metres per z14 pixel


def merc_px(lat, lon):
    """lat/lon -> pixel in the z14 mosaic."""
    x = (lon + 180) / 360 * 2 ** Z * 256
    r = math.radians(lat)
    y = (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z * 256
    return x - X0T * 256, y - Y0T * 256


def px_to_local(px, py):
    """mosaic pixel -> scene units (x east, y north), origin at mosaic centre."""
    return (px - SAT_W / 2) * MPP / UNIT, -(py - SAT_H / 2) * MPP / UNIT


# ----------------------------------------------------------------------------- mosaics from raw tiles
if not (G / 'sat_z14.jpg').exists():
    sat_m = Image.new('RGB', (SAT_W, SAT_H))
    for x in range(X0T, X0T + 15):
        for y in range(Y0T, Y0T + 16):
            sat_m.paste(Image.open(G / 'raw' / 'sat' / f'14_{x}_{y}.jpg').convert('RGB'), ((x - X0T) * 256, (y - Y0T) * 256))
    sat_m.save(G / 'sat_z14.jpg', quality=92)
if not (G / 'dem_z13.npy').exists():
    m = np.zeros((8 * 256, 8 * 256), np.float32)
    for x in range(X0T // 2, X0T // 2 + 8):
        for y in range(Y0T // 2, Y0T // 2 + 8):
            a = np.asarray(Image.open(G / 'raw' / 'dem' / f'13_{x}_{y}.png').convert('RGB')).astype(np.float32)
            m[(y - Y0T // 2) * 256:(y - Y0T // 2 + 1) * 256, (x - X0T // 2) * 256:(x - X0T // 2 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    np.save(G / 'dem_z13.npy', m)

# ----------------------------------------------------------------------------- elevation
dem = np.load(G / 'dem_z13.npy')[:, : SAT_W // 2].astype(np.float32)    # z13 px = 2 z14 px
p_ = np.pad(dem, 1, mode='edge')                    # 3x3 mean: tame SRTM speckle
dem = sum(p_[1 + dy:1 + dy + dem.shape[0], 1 + dx:1 + dx + dem.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9
DH, DW = dem.shape

# ----------------------------------------------------------------------------- lake mask
osm = json.loads((G / 'raw' / 'osm.json').read_text(encoding='utf8'))


def ring_px(geom, scale=0.5):
    return [tuple(v * scale for v in merc_px(p['lat'], p['lon'])) for p in geom]


lake_rel = next(e for e in osm['elements'] if e['type'] == 'relation' and e.get('tags', {}).get('natural') == 'water')
mask_img = Image.new('L', (DW, DH), 0); d = ImageDraw.Draw(mask_img)
inner_rings = []
for m in lake_rel['members']:
    if m.get('role') == 'outer': d.polygon(ring_px(m['geometry']), fill=255)
for m in lake_rel['members']:
    if m.get('role') == 'inner': d.polygon(ring_px(m['geometry']), fill=0); inner_rings.append(m['geometry'])
lake = np.asarray(mask_img) > 127
# other ponds (texture only, kept flat at their own level)
ponds_img = Image.new('L', (DW, DH), 0); dp = ImageDraw.Draw(ponds_img)
for e in osm['elements']:
    if e['type'] == 'way' and e.get('tags', {}).get('natural') == 'water': dp.polygon(ring_px(e['geometry']), fill=255)
ponds = (np.asarray(ponds_img) > 127) & ~lake

level = float(np.median(dem[np.asarray(mask_img.filter(ImageFilter.MinFilter(9))) > 127]))
# distance from shore (pixels) by repeated erosion
dist = np.zeros(lake.shape, np.float32); cur = mask_img
for i in range(1, 70):
    cur = cur.filter(ImageFilter.MinFilter(3)); a = np.asarray(cur) > 127
    dist[a] = i
    if not a.any(): break
dist_m = dist * MPP * 2
depth_m = np.minimum(10.0, 0.6 + dist_m * 0.012)          # real max depth ~10 m, mean 5.7 m
height = (dem - level) / UNIT * VE
height = np.where(lake, -depth_m / UNIT * VE, height)
# Keep the land near the lake just above the (rectangular) water surface.
ys, xs = np.nonzero(lake); pad = 40
bb = (max(ys.min() - pad, 0), min(ys.max() + pad, DH), max(xs.min() - pad, 0), min(xs.max() + pad, DW))
sub = height[bb[0]:bb[1], bb[2]:bb[3]]; lk = lake[bb[0]:bb[1], bb[2]:bb[3]]
sub[~lk] = np.maximum(sub[~lk], 0.06)
# Kazachy Island (16 ha) is flat at lake level in SRTM; give it a low wooded dome (~8 m real).
isl_img = Image.new('L', (DW, DH), 0); di = ImageDraw.Draw(isl_img)
for ring in inner_rings: di.polygon(ring_px(ring), fill=255)
isl_d = np.zeros(lake.shape, np.float32); cur = isl_img
for i in range(1, 30):
    a = np.asarray(cur) > 127
    if not a.any(): break
    isl_d[a] = i; cur = cur.filter(ImageFilter.MinFilter(3))
height = np.where(isl_d > 0, np.maximum(height, 0.12 + np.minimum(isl_d, 8) / 8 * 8 / UNIT * VE), height)
grid = height[::DEM_STEP, ::DEM_STEP].astype(np.float32)
np.save(OUT / 'height.npy', grid)
gx0, gy0 = px_to_local(0, 0); gx1, gy1 = px_to_local((DW - 1) * 2, (DH - 1) * 2)

# ----------------------------------------------------------------------------- texture
sat = Image.open(G / 'sat_z14.jpg').convert('RGB')
sat = ImageEnhance.Color(sat).enhance(1.35)
sat = ImageEnhance.Contrast(sat).enhance(1.12)
sat = ImageEnhance.Brightness(sat).enhance(1.12)
s = np.asarray(sat, np.float32) / 255
lake_hi = np.asarray(mask_img.resize((SAT_W, SAT_H), Image.BILINEAR), np.float32)[..., None] / 255
ponds_hi = np.asarray(ponds_img.resize((SAT_W, SAT_H), Image.BILINEAR), np.float32)[..., None] / 255
bed = np.array([0.36, 0.42, 0.38], np.float32)        # lake bed seen through the water
s = s * (1 - lake_hi) + (s * 0.4 + bed * 0.6) * lake_hi
tex = Image.fromarray((np.clip(s, 0, 1) * 255).astype(np.uint8)).resize((4096, 4096), Image.LANCZOS)
tex.save(OUT / 'texture.png')

# ----------------------------------------------------------------------------- forest -> pine instances
small = np.asarray(Image.open(G / 'sat_z14.jpg').convert('RGB').resize((DW, DH), Image.BILINEAR), np.float32) / 255
lum = small @ np.array([0.3, 0.59, 0.11], np.float32)
dark_forest = (lum < 0.2) & (small[..., 1] > small[..., 0] * 1.02) & ~lake & ~ponds
rng = np.random.default_rng(2026)
# candidates on a jittered 40 m grid around the lake and on the Imantau massif
spacing = 1.05 / (MPP * 2 / UNIT)       # DEM pixels per ~1 unit
cy, cx = np.mgrid[0:DH:spacing, 0:DW:spacing]
cx = (cx + rng.uniform(-0.45, 0.45, cx.shape) * spacing).ravel(); cy = (cy + rng.uniform(-0.45, 0.45, cy.shape) * spacing).ravel()
ok = (cx >= 0) & (cx < DW - 1) & (cy >= 0) & (cy < DH - 1); cx, cy = cx[ok], cy[ok]
ix, iy = cx.astype(int), cy.astype(int)
# distance to the lake (pixels) using the lake bbox centre as a cheap proxy + elevation of the massif
lcx, lcy = xs.mean(), ys.mean()
near = np.hypot((ix - lcx) * 0.75, iy - lcy) < 520
keep = dark_forest[iy, ix] & (near | (dem[iy, ix] > level + 70))
pts = np.stack([cx[keep], cy[keep]], 1)
BUDGET = 7000
if len(pts) > BUDGET:
    # prefer trees closest to the lake shore and on the mountain slope facing it
    # Imantau massif (pine-covered slopes, ru.wikipedia) first, then the lake shores.
    massif = dem[pts[:, 1].astype(int), pts[:, 0].astype(int)] > level + 45
    score = np.hypot((pts[:, 0] - lcx) * 0.75, pts[:, 1] - lcy) * np.where(massif, 0.35, 1.0) + rng.uniform(0, 120, len(pts))
    pts = pts[np.argsort(score)[:BUDGET]]
tx, ty = px_to_local(pts[:, 0] * 2, pts[:, 1] * 2)
tz = height[pts[:, 1].astype(int), pts[:, 0].astype(int)]
trees = np.stack([tx, ty, tz, rng.uniform(0.85, 1.25, len(pts))], 1).astype(np.float32)
np.save(OUT / 'trees.npy', trees)

# ----------------------------------------------------------------------------- buildings, POIs
def to_local(lat, lon):
    px, py = merc_px(lat, lon); return px_to_local(px, py)


def h_at(x, y):
    px = (x * UNIT / MPP + SAT_W / 2) / 2; py = (-(y * UNIT / MPP) + SAT_H / 2) / 2
    return float(height[int(np.clip(py, 0, DH - 1)), int(np.clip(px, 0, DW - 1))])


buildings = []
for e in osm['elements']:
    if e['type'] == 'way' and 'building' in e.get('tags', {}) and len(e.get('geometry', [])) >= 4:
        ring = [to_local(p['lat'], p['lon']) for p in e['geometry'][:-1]]
        cxb = sum(p[0] for p in ring) / len(ring); cyb = sum(p[1] for p in ring) / len(ring)
        levels = float(e['tags'].get('building:levels', 1) or 1)
        buildings.append({'ring': [[round(a, 3), round(c, 3)] for a, c in ring], 'base': round(h_at(cxb, cyb), 3), 'h': round(min(levels, 5) * 3.2 / UNIT * VE, 3)})

places = {}
try:
    po = json.loads((G / 'raw' / 'osm_places.json').read_text(encoding='utf8'))
    for e in po['elements']:
        t = e.get('tags', {})
        if e['type'] == 'node' and t.get('place') in ('village', 'hamlet', 'town'):
            places[t.get('name', '')] = to_local(e['lat'], e['lon'])
except Exception as ex:  # optional
    print('places unavailable', ex)

# Kazachy Island = inner ring of the lake relation (largest one)
isl = max(inner_rings, key=len) if inner_rings else None
island = np.mean([to_local(p['lat'], p['lon']) for p in isl], 0) if isl else to_local(52.985, 68.30)
# Imantau peak: highest DEM point within ~2 km of the reference coordinate 52°56′45″N 68°17′16″E
ppx, ppy = merc_px(52 + 56 / 60 + 45 / 3600, 68 + 17 / 60 + 16 / 3600); ppx /= 2; ppy /= 2
r = int(2000 / (MPP * 2)); win = dem[int(ppy) - r:int(ppy) + r, int(ppx) - r:int(ppx) + r]
wy, wx = np.unravel_index(np.argmax(win), win.shape)
peak_px = (int(ppx) - r + wx, int(ppy) - r + wy)
peak = px_to_local(peak_px[0] * 2, peak_px[1] * 2); peak_ele = float(dem[peak_px[1], peak_px[0]])
lake_c = px_to_local(lcx * 2, lcy * 2)
pois = {
    'POI_lake': [*lake_c, 0.4],
    'POI_island': [float(island[0]), float(island[1]), h_at(*island) + 1.0],
    'POI_mountain': [*peak, h_at(*peak) + 1.5],
}
# NE slope of the massif: halfway between the peak and the southern lake shore
slope = ((peak[0] * 0.55 + lake_c[0] * 0.45), (peak[1] * 0.55 + lake_c[1] * 0.45))
for k in range(40):  # walk toward the peak until on land
    if h_at(*slope) > 1: break
    slope = (slope[0] + (peak[0] - slope[0]) * 0.1, slope[1] + (peak[1] - slope[1]) * 0.1)
pois['POI_slope'] = [*slope, h_at(*slope) + 1.0]
for name, key in (('Имантау', 'POI_village'), ('Арыкбалык', 'POI_arykbalyk'), ('Арықбалық', 'POI_arykbalyk')):
    if name in places: pois[key] = [*places[name], h_at(*places[name]) + 1.0]
scene = {'unitMetres': UNIT, 'verticalExaggeration': VE, 'lakeLevelM': round(level, 1), 'peakEleM': round(peak_ele, 1),
         'extent': [gx0, gx1, gy1, gy0], 'grid': list(grid.shape), 'lakeBBox': [*px_to_local(bb[2] * 2, bb[1] * 2), *px_to_local(bb[3] * 2, bb[0] * 2)],
         'trees': len(trees), 'buildings': buildings, 'pois': pois, 'places': places,
         'bounds': b, 'mpp': MPP}
(OUT / 'scene.json').write_text(json.dumps(scene, ensure_ascii=False), encoding='utf8')
print(json.dumps({k: v for k, v in scene.items() if k != 'buildings'}, indent=1))
print('buildings', len(buildings))
