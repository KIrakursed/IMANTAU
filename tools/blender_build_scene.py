"""IMANTAU — build the lake scene from scratch in Blender, following the reference photo.

Run (Blender 4.2+ / 5.x, headless):
    blender -b --factory-startup --python tools/blender_build_scene.py

Inputs : assets/source/pine-tree   (Tree.fbx + textures)      — the pine used for every tree
         assets/source/water-animation (Water_Animation.fbx) — animated water surface (shape keys)
Output : public/scenes/IMANTAU-scene.glb, work/blender/IMANTAU-scene.blend,
         work/blender/*.png (generated textures), work/diagnostics/scene.json

Coordinates: Blender Z-up metres-ish units; water level z = 0. glTF export converts to Y-up
(x, y, z) -> (x, z, -y). Everything is deterministic (fixed seeds).
"""
import json, math, time
from pathlib import Path
import numpy as np
import bpy, bmesh

ROOT = Path(__file__).resolve().parents[1]
PINE = ROOT / 'assets' / 'source' / 'pine-tree'
WATER = ROOT / 'assets' / 'source' / 'water-animation'
OUT = ROOT / 'public' / 'scenes' / 'IMANTAU-scene.glb'
WORK = ROOT / 'work' / 'blender'; WORK.mkdir(parents=True, exist_ok=True)
REPORT = {}
T0 = time.time()

# ----------------------------------------------------------------------------- noise
_rng = np.random.default_rng(1115)
_PERM = np.concatenate([_rng.permutation(256)] * 2)
_VALS = _rng.random(256).astype(np.float32)


def vnoise(x, y):
    xi = np.floor(x).astype(np.int64); yi = np.floor(y).astype(np.int64)
    xf = (x - xi).astype(np.float32); yf = (y - yi).astype(np.float32)
    u = xf * xf * (3 - 2 * xf); v = yf * yf * (3 - 2 * yf)
    def h(i, j): return _VALS[_PERM[(_PERM[i & 255] + j) & 255]]
    a = h(xi, yi); b = h(xi + 1, yi); c = h(xi, yi + 1); d = h(xi + 1, yi + 1)
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v


def fbm(x, y, octaves=5, lac=2.03, gain=0.5, seed=0.0):
    total = np.zeros_like(x, dtype=np.float32); amp = 1.0; f = 1.0; norm = 0.0
    for o in range(octaves):
        total += amp * vnoise(x * f + 17.3 * o + seed, y * f - 9.1 * o + seed * 1.7); norm += amp
        amp *= gain; f *= lac
    return total / norm


def ridged(x, y, octaves=4, seed=0.0):
    total = np.zeros_like(x, dtype=np.float32); amp = 1.0; f = 1.0; norm = 0.0
    for o in range(octaves):
        n = 1 - np.abs(2 * vnoise(x * f + 31.7 * o + seed, y * f + 5.3 * o) - 1); total += amp * n * n; norm += amp
        amp *= 0.5; f *= 2.1
    return total / norm


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)


def ellipse_sdf(x, y, cx, cy, rx, ry, rot_deg=0.0):
    r = math.radians(rot_deg); c, s = math.cos(r), math.sin(r)
    dx, dy = x - cx, y - cy; u = (dx * c + dy * s) / rx; v = (-dx * s + dy * c) / ry
    return (np.sqrt(u * u + v * v) - 1) * min(rx, ry)


# ----------------------------------------------------------------------------- layout (reference)
X0, X1, Y0, Y1 = -190.0, 190.0, -120.0, 320.0
LAKES = [(0, 5, 48, 26, 0), (52, 38, 40, 12, 28), (30, -14, 20, 13, 0), (-62, 50, 20, 5, 10)]
ISLAND = (-14, 10, 13, 5.5, -10)
ISLET = (40, 30, 3.2, 2.2, 20)
ROCKS = [(-8, -62, 15, 9), (-55, -12, 10, 7), (-82, 40, 9, 6), (-40, -46, 8, 6), (-24, -70, 9, 6)]
BEACH = (38, -27, 17)
ROAD = [(80, -70), (64, -46), (52, -36), (40, -33), (24, -38), (6, -47), (-18, -42), (-46, -30), (-75, -22), (-110, -20)]
CABINS = [(46, -33, 20), (53, -27, 35), (58, -38, 10), (44, -42, 0), (62, -30, 40), (36, -40, 15)]
PIER = ((35.5, -26.5), (27.5, -18.5))


def lake_sdf(x, y):
    d = np.min([ellipse_sdf(x, y, *e) for e in LAKES], axis=0)
    return d + (fbm(x / 22, y / 22, 3, seed=4) - 0.5) * 7


def road_dist(x, y):
    best = np.full(x.shape, 1e9, dtype=np.float32)
    for (ax, ay), (bx, by) in zip(ROAD, ROAD[1:]):
        px, py = x - ax, y - ay; vx, vy = bx - ax, by - ay
        t = np.clip((px * vx + py * vy) / (vx * vx + vy * vy), 0, 1)
        best = np.minimum(best, np.hypot(px - t * vx, py - t * vy))
    return best + (fbm(x / 9, y / 9, 2, seed=8) - 0.5) * 1.2


def fields(x, y):
    """Height + masks for arrays of world x, y."""
    d = lake_sdf(x, y)
    beach = np.exp(-((x - BEACH[0]) ** 2 + (y - BEACH[1]) ** 2) / BEACH[2] ** 2)
    # land: low rolling forest hills rising away from the shore
    hills = (fbm(x / 48, y / 48, 5, seed=2) - 0.35) * 16
    land = 1.2 + 1.6 * smooth(0, 10, d) + np.maximum(hills, 0) * smooth(4, 35, d) * (1 - beach)
    # Reference: a broad forested massif behind the lake whose summit rises above the horizon.
    m = (46 * np.exp(-((x - 5) / 95) ** 2 - ((y - 236) / 50) ** 2)
         + 29 * np.exp(-((x + 80) / 60) ** 2 - ((y - 222) / 40) ** 2)
         + 25 * np.exp(-((x - 95) / 62) ** 2 - ((y - 226) / 40) ** 2))
    mountain = m * (0.85 + 0.3 * ridged(x / 26, y / 26, 4, seed=3))
    rock = np.zeros_like(x)
    for cx, cy, r, h in ROCKS:
        g = np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / r ** 2)
        rock = np.maximum(rock, g)
        land = land + h * g * (0.55 + 0.9 * ridged(x / 5, y / 5, 3, seed=cx))
    # lake bed: gentle shallows at the beach cove, deeper elsewhere
    soft = 10 + 14 * beach
    bed = -6 * (1 - np.exp(np.minimum(d, 0) / soft))
    h = np.where(d > 0, land + mountain, bed + 0.15)
    # islands
    for (cx, cy, rx, ry, rot), top in ((ISLAND, 4.2), (ISLET, 2.3)):
        di = ellipse_sdf(x, y, cx, cy, rx, ry, rot) + (fbm(x / 6, y / 6, 2, seed=cx) - 0.5) * 2.5
        hi = -1.0 + (top + 1.0) * smooth(-1.5, 6, -di) * (0.75 + 0.5 * fbm(x / 4, y / 4, 3, seed=9))
        h = np.where(di < 4, np.maximum(h, hi), h)
        rock = np.maximum(rock, smooth(1.5, -1.5, np.abs(di + 0.6)) * 0.55 * (cx == ISLAND[0]))
    island_d = ellipse_sdf(x, y, *ISLAND); islet_d = ellipse_sdf(x, y, *ISLET)
    return h.astype(np.float32), d, beach, rock, island_d, islet_d, mountain


def forest_mask(x, y, h, d, beach, rock, slope):
    f = smooth(0.3, 0.44, fbm(x / 30, y / 30, 4, seed=6))
    clearing = np.exp(-((x - 50) ** 2 + (y - 34 + 70) ** 2) / 14 ** 2)  # cabins clearing
    return f * (h > 0.7) * smooth(26, 14, h) * smooth(0.9, 0.5, slope) * (1 - smooth(0.25, 0.5, rock)) * (1 - beach * 0.95) * (1 - clearing)


# ----------------------------------------------------------------------------- helpers
def srgb_to_lin(c):
    c = np.asarray(c, dtype=np.float32); return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hexc(h):
    h = h.lstrip('#'); return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], dtype=np.float32)


def mixc(a, b, t):
    t = np.asarray(t, np.float32)
    if t.ndim: t = t[..., None]
    return a * (1 - t) + b * t


def save_image(name, rgba, path):
    hgt, wid = rgba.shape[:2]
    img = bpy.data.images.new(name, wid, hgt, alpha=rgba.shape[2] == 4)
    flat = np.ascontiguousarray(rgba if rgba.shape[2] == 4 else np.dstack([rgba, np.ones((hgt, wid), np.float32)]), dtype=np.float32).ravel()
    img.pixels.foreach_set(flat)
    img.filepath_raw = str(path); img.file_format = 'PNG'; img.save()
    return img


def material(name, image=None, color=None, rough=0.9, normal_img=None, alpha_clip=False, specular=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Roughness'].default_value = rough
    if specular is not None and 'Specular IOR Level' in p.inputs: p.inputs['Specular IOR Level'].default_value = specular
    if image is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image
        nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
        if alpha_clip:
            r = nt.nodes.new('ShaderNodeMath'); r.operation = 'ROUND'
            nt.links.new(t.outputs['Alpha'], r.inputs[0]); nt.links.new(r.outputs['Value'], p.inputs['Alpha'])
    elif color is not None:
        p.inputs['Base Color'].default_value = (*srgb_to_lin(hexc(color)), 1)
    if normal_img is not None:
        normal_img.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = normal_img
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    return m


def link(ob):
    bpy.context.scene.collection.objects.link(ob); return ob


# ----------------------------------------------------------------------------- start
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ----------------------------------------------------------------------------- terrain mesh
STEP = 1.2
xs = np.arange(X0, X1 + 1e-3, STEP, dtype=np.float32); ys = np.arange(Y0, Y1 + 1e-3, STEP, dtype=np.float32)
GX, GY = np.meshgrid(xs, ys)
H, *_ = fields(GX, GY)
# Keep the terrain mesh safely below the water plane inside the lake basin.
# Preserve the two authored islands above water; the shoreline itself remains governed by lake_sdf.
lake_d = lake_sdf(GX, GY)
island_d = ellipse_sdf(GX, GY, *ISLAND)
islet_d = ellipse_sdf(GX, GY, *ISLET)
underwater = (lake_d <= 0.0) & (island_d > 0.0) & (islet_d > 0.0)
H = np.where(underwater, np.minimum(H, -0.35), H).astype(np.float32)
nx, ny = len(xs), len(ys)
verts = np.stack([GX.ravel(), GY.ravel(), H.ravel()], 1)
idx = np.arange(nx * ny).reshape(ny, nx)
quads = np.stack([idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()], 1)
me = bpy.data.meshes.new('Terrain')
me.from_pydata(verts.tolist(), [], quads.tolist())
uv = me.uv_layers.new(name='UVMap')
loop_v = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', loop_v)
uvs = np.stack([(verts[loop_v, 0] - X0) / (X1 - X0), (verts[loop_v, 1] - Y0) / (Y1 - Y0)], 1).astype(np.float32)
uv.data.foreach_set('uv', uvs.ravel())
me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
terrain = link(bpy.data.objects.new('Terrain', me))
REPORT['terrain'] = {'vertices': len(me.vertices), 'faces': len(me.polygons), 'extent': [X0, X1, Y0, Y1]}
print('terrain mesh', time.time() - T0)

# ----------------------------------------------------------------------------- terrain texture
TEX = 4096
C = {k: srgb_to_lin(hexc(v)) for k, v in dict(
    meadow='#5f8a3c', meadow2='#4a7530', forest='#2b4a21', canopy='#1f3a18', canopy2='#3d6a2c',
    sand='#e0cda3', wetsand='#b7a37a', granite='#a19b8e', granite2='#67645c', lichen='#8e9466',
    bed_shallow='#cbb98c', bed_deep='#21434a', mrock='#9d9b90', road='#cdb88e', soil='#7b6a4c').items()}
tex = np.zeros((TEX, TEX, 3), np.float32)
CH = 256
for r0 in range(0, TEX, CH):
    rows = np.arange(r0 - 1, r0 + CH + 1)
    v = (rows + 0.5) / TEX; u = (np.arange(TEX) + 0.5) / TEX
    X, Y = np.meshgrid(X0 + u * (X1 - X0), Y0 + v * (Y1 - Y0))
    X = X.astype(np.float32); Y = Y.astype(np.float32)
    h, d, beach, rock, idd, ild, mtn = fields(X, Y)
    px = (X1 - X0) / TEX
    gy, gx = np.gradient(h, px); slope = np.hypot(gx, gy)
    sl = slice(1, -1)
    X, Y, h, d, beach, rock, idd, mtn, slope = (a[sl] for a in (X, Y, h, d, beach, rock, idd, mtn, slope))
    fm = forest_mask(X, Y, h, d, beach, rock, slope)
    col = mixc(C['meadow'], C['meadow2'], fbm(X / 14, Y / 14, 4, seed=1))
    canopy = mixc(C['canopy'], C['canopy2'], smooth(0.35, 0.75, fbm(X / 1.6, Y / 1.6, 3, seed=11)))
    col = mixc(col, mixc(C['forest'], canopy, 0.7), np.clip(fm * 1.15, 0, 1))
    # far mountain: forested slopes with grey granite ribs near ridges/tops
    mr = smooth(0.74, 0.86, ridged(X / 9, Y / 9, 4, seed=5)) * smooth(22, 45, mtn) * 0.8 + smooth(1.5, 2.2, slope) * smooth(20, 36, mtn) * 0.45
    mforest = mixc(C['forest'], C['canopy2'], fbm(X / 3, Y / 3, 3, seed=12) * 0.8)
    col = np.where((mtn > 6)[..., None], mixc(mforest, C['mrock'], np.clip(mr, 0, 1)), col)
    # granite outcrops
    gran = mixc(C['granite'], C['granite2'], smooth(0.45, 0.8, ridged(X / 1.3, Y / 1.3, 3, seed=7)))
    gran = mixc(gran, C['lichen'], smooth(0.62, 0.8, fbm(X / 2.5, Y / 2.5, 3, seed=13)) * 0.6)
    col = mixc(col, gran, smooth(0.3, 0.55, rock) * (h > 0.4))
    # road and cabin clearing soil
    col = mixc(col, C['road'], smooth(1.6, 0.8, road_dist(X, Y)) * (h > 0.4))
    # shoreline: thin sand rim everywhere, wide beach in the cove
    rim = smooth(1.6, 0.2, d) * (d > -0.4)
    col = mixc(col, C['wetsand'], rim * 0.8)
    col = mixc(col, C['sand'], np.clip(beach * 1.4, 0, 1) * smooth(9, 1, d) * (d > -1))
    # lake bed (seen through the semi-transparent water): pale sand shallows -> deep teal
    depth = np.clip(-h, 0, 6)
    bed = mixc(C['bed_shallow'], C['bed_deep'], smooth(0.2, 3.5, depth))
    col = np.where((h < 0.15)[..., None], bed, col)
    # micro grain
    col *= (0.9 + 0.2 * fbm(X * 1.7, Y * 1.7, 2, seed=21))[..., None]
    tex[r0:r0 + CH] = col
# linear -> sRGB bytes for the image
tex_s = np.where(tex <= 0.0031308, tex * 12.92, 1.055 * np.power(np.clip(tex, 0, None), 1 / 2.4) - 0.055)
terrain_img = save_image('terrain_basecolor', np.clip(tex_s, 0, 1), WORK / 'terrain_basecolor.png')
terrain_img.colorspace_settings.name = 'sRGB'
me.materials.append(material('Terrain', image=terrain_img, rough=0.95, specular=0.3))
print('terrain texture', time.time() - T0)

# ----------------------------------------------------------------------------- pine (provided asset)
bpy.ops.import_scene.fbx(filepath=str(PINE / 'source' / 'Tree.fbx'))
leaves = bpy.data.objects['Leaves/001']; trunk = bpy.data.objects['Trank.001']
img_l = bpy.data.images.load(str(PINE / 'textures' / 'Leavs_basecolor_.tga.png'))
img_o = bpy.data.images.load(str(PINE / 'textures' / 'Leavs_Opacity.png'))
w, hh = img_l.size
L = np.array(img_l.pixels[:], np.float32).reshape(hh, w, 4)
O = np.array(img_o.pixels[:], np.float32).reshape(hh, w, img_o.channels)[..., 0]
# Re-colour the olive needles to the deep pine green of the reference, keeping their shading.
lum = L[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32)
lum = lum / max(lum[O > 0.5].mean(), 1e-3)
pine = hexc('#3e6b34'); tip = hexc('#5d8c45')
needles = (pine[None, None] * (1 - lum[..., None] * 0.25) + tip[None, None] * lum[..., None] * 0.25) * np.clip(lum, 0.55, 1.35)[..., None]
needle_img = save_image('pine_needles', np.dstack([np.clip(needles, 0, 1), O]), WORK / 'pine_needles.png')
mat_leaves = material('Pine_Needles', image=needle_img, rough=0.92, alpha_clip=True, specular=0.2)
mat_trunk = material('Pine_Bark', image=bpy.data.images.load(str(PINE / 'textures' / 'Trank_basecolor.tga.png')),
                     rough=0.95, normal_img=bpy.data.images.load(str(PINE / 'textures' / 'Trank_normal.tga.png')))
leaves.data.materials.clear(); leaves.data.materials.append(mat_leaves)
trunk.data.materials.clear(); trunk.data.materials.append(mat_trunk)
# Lighter web version of the needle cards (thousands of instances).
src_faces = len(leaves.data.polygons)
bpy.context.view_layer.objects.active = leaves
for o in bpy.context.view_layer.objects: o.select_set(o == leaves)
dec = leaves.modifiers.new('decimate', 'DECIMATE'); dec.ratio = 0.35
bpy.ops.object.modifier_apply(modifier=dec.name)
for o in bpy.context.view_layer.objects: o.select_set(o in (leaves, trunk))
bpy.context.view_layer.objects.active = leaves
bpy.ops.object.join()
pine_obj = leaves; pine_obj.name = 'Pine'; pine_obj.data.name = 'Pine'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
pz = min((pine_obj.matrix_world @ v.co).z for v in pine_obj.data.vertices)
REPORT['pine'] = {'sourceNeedleFaces': src_faces, 'webFaces': len(pine_obj.data.polygons), 'height': round(pine_obj.dimensions.z, 2)}
pine_tris = sum(len(p.vertices) - 2 for p in pine_obj.data.polygons)

# ----------------------------------------------------------------------------- tree scatter
rng = np.random.default_rng(42)
S = 2.15
cx, cy = np.meshgrid(np.arange(-135, 135, S), np.arange(-112, 125, S))
cx = (cx + rng.uniform(-0.45, 0.45, cx.shape) * S).ravel().astype(np.float32)
cy = (cy + rng.uniform(-0.45, 0.45, cy.shape) * S).ravel().astype(np.float32)
th, td, tb, tr, tid, tld, tm = fields(cx, cy)
e = 0.6
hx = (fields(cx + e, cy)[0] - fields(cx - e, cy)[0]) / (2 * e); hy = (fields(cx, cy + e)[0] - fields(cx, cy - e)[0]) / (2 * e)
tslope = np.hypot(hx, hy)
fm = forest_mask(cx, cy, th, td, tb, tr, tslope)
on_island = (tid < 0) | (tld < 0)
keep = ((fm > rng.random(cx.shape) * 0.9 + 0.08) & (td > 2.2) & (road_dist(cx, cy) > 2.2)) | (on_island & (th > 0.9))
# far trees are mostly painted in the texture; thin them to save triangles
far = (cy > 70) | (np.abs(cx) > 105)
keep &= ~(far & (rng.random(cx.shape) > 0.35))
pts = np.stack([cx[keep], cy[keep], th[keep]], 1)
BUDGET = int(4_200_000 / pine_tris)
if len(pts) > BUDGET:
    pts = pts[rng.choice(len(pts), BUDGET, replace=False)]
forest = bpy.data.objects.new('Forest', None); link(forest)
for i, (x, y, z) in enumerate(pts):
    o = pine_obj.copy(); o.name = f'Pine_{i:05d}'
    s = float(rng.uniform(0.95, 1.45)); o.scale = (s, s, s * float(rng.uniform(0.95, 1.15)))
    o.rotation_euler = (float(rng.normal(0, 0.03)), float(rng.normal(0, 0.03)), float(rng.uniform(0, 6.283)))
    o.location = (float(x), float(y), float(z) - pz * s - 0.15)
    o.parent = forest; link(o)
bpy.data.objects.remove(pine_obj)  # template only; the copies keep the mesh data
REPORT['forest'] = {'trees': int(len(pts)), 'trianglesPerTree': pine_tris, 'budgetTrees': BUDGET}
print('trees', len(pts), time.time() - T0)

# ----------------------------------------------------------------------------- granite boulders
gran_px = 512
gx_, gy_ = np.meshgrid(np.arange(gran_px) / 40, np.arange(gran_px) / 40)
gcol = mixc(srgb_to_lin(hexc('#a39d90')), srgb_to_lin(hexc('#5d5a53')), smooth(0.4, 0.8, ridged(gx_, gy_, 4, seed=3)))
gcol = mixc(gcol, srgb_to_lin(hexc('#8f9468')), smooth(0.6, 0.78, fbm(gx_ / 2, gy_ / 2, 3, seed=4)) * 0.5)
gcol *= (0.85 + 0.3 * fbm(gx_ * 8, gy_ * 8, 2, seed=5))[..., None]
gcol_s = np.where(gcol <= 0.0031308, gcol * 12.92, 1.055 * np.power(gcol, 1 / 2.4) - 0.055)
granite_img = save_image('granite', np.clip(gcol_s, 0, 1), WORK / 'granite.png')
mat_granite = material('Granite', image=granite_img, rough=0.88, specular=0.35)
boulders = bpy.data.objects.new('Boulders', None); link(boulders)
brng = np.random.default_rng(7); nb = 0
for (rx, ry, rr, rh) in ROCKS + [(ISLAND[0], ISLAND[1], 4, 2)]:
    for k in range(int(rr * 1.6)):
        a = brng.uniform(0, 6.283); dist = abs(brng.normal(0, rr * 0.45))
        bx, by = rx + math.cos(a) * dist, ry + math.sin(a) * dist
        bz = float(fields(np.array([bx], np.float32), np.array([by], np.float32))[0][0])
        if bz < 0.3: continue
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        sz = brng.uniform(0.8, 2.2) * (rh / 7 + 0.4); sq = brng.uniform(0.5, 0.8)
        for v in bm.verts:
            n = float(fbm(np.array([v.co.x * 1.3 + k], np.float32), np.array([v.co.y * 1.3 + v.co.z], np.float32), 3, seed=nb)[0])
            v.co *= (0.6 + 0.8 * n)
            v.co.z *= sq
        bm.normal_update()
        uvl = bm.loops.layers.uv.new('UVMap')
        for f in bm.faces:
            for l in f.loops:
                c = l.vert.co; l[uvl].uv = ((c.x + c.z * 0.5) * 0.35 + nb * 0.13, (c.y + c.z * 0.5) * 0.35)
        bme = bpy.data.meshes.new(f'Boulder_{nb:03d}'); bm.to_mesh(bme); bm.free()
        bme.polygons.foreach_set('use_smooth', np.ones(len(bme.polygons), bool))
        bme.materials.append(mat_granite)
        o = bpy.data.objects.new(f'Boulder_{nb:03d}', bme); o.parent = boulders; link(o)
        o.location = (bx, by, bz + sz * sq * 0.25); o.scale = (sz, sz * brng.uniform(0.7, 1.2), sz)
        o.rotation_euler = (0, 0, brng.uniform(0, 6.283)); nb += 1
REPORT['boulders'] = nb

# ----------------------------------------------------------------------------- beach village: cabins + pier
mat_wood = material('Wood_Log', color='#7a4f31', rough=0.85)
mat_roof = material('Roof', color='#5b3427', rough=0.8)
mat_plank = material('Pier_Plank', color='#9a7b57', rough=0.85)
village = bpy.data.objects.new('Village', None); link(village)


def box(name, size, loc, rot, mat, parent):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    m_ = bpy.data.meshes.new(name); bm.to_mesh(m_); bm.free(); m_.materials.append(mat)
    o = bpy.data.objects.new(name, m_); o.location = loc; o.rotation_euler = (0, 0, math.radians(rot)); o.parent = parent; link(o); return o


for i, (x, y, rot) in enumerate(CABINS):
    z = float(fields(np.array([x], np.float32), np.array([y], np.float32))[0][0])
    box(f'Cabin_{i}', (4.2, 3.2, 2.4), (x, y, z + 1.0), rot, mat_wood, village)
    bm = bmesh.new()
    a, b_, hgt = 2.45, 1.95, 1.5
    vs = [bm.verts.new(p) for p in [(-a, -b_, 0), (a, -b_, 0), (a, b_, 0), (-a, b_, 0), (-a, 0, hgt), (a, 0, hgt)]]
    for f in [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]: bm.faces.new([vs[j] for j in f])
    bm.normal_update(); rm = bpy.data.meshes.new(f'Roof_{i}'); bm.to_mesh(rm); bm.free(); rm.materials.append(mat_roof)
    ro = bpy.data.objects.new(f'Roof_{i}', rm); ro.location = (x, y, z + 2.2); ro.rotation_euler = (0, 0, math.radians(rot)); ro.parent = village; link(ro)
(ax, ay), (bx, by) = PIER
ang = math.degrees(math.atan2(by - ay, bx - ax)); ln = math.hypot(bx - ax, by - ay)
box('Pier_Deck', (ln, 1.6, 0.18), ((ax + bx) / 2, (ay + by) / 2, 0.55), ang, mat_plank, village)
box('Pier_Head', (3.5, 4.0, 0.18), (bx, by, 0.55), ang, mat_plank, village)

# ----------------------------------------------------------------------------- water (provided asset)
bpy.ops.import_scene.fbx(filepath=str(WATER / 'source' / 'Water_Animation.fbx'))
water = bpy.data.objects['Water Export']; water.name = 'Lake_Water'; water.data.name = 'Lake_Water'
keys = water.data.shape_keys.key_blocks if water.data.shape_keys else []
# The FBX also animates the object transform (identity keys); it would override the lake scale, so
# keep only the shape-key (wave) animation.
if water.animation_data and water.animation_data.action:
    act = water.animation_data.action; water.animation_data.action = None; bpy.data.actions.remove(act)
# Cover every lake basin (x -85..95, y -35..65); flatten the ocean-sized swell to a calm lake ripple.
water.location = (5, 15, 0.02); water.scale = (1.95, 1.95, 0.035)
uvw = water.data.uv_layers[0]
uvd = np.empty(len(uvw.data) * 2, np.float32); uvw.data.foreach_get('uv', uvd); uvw.data.foreach_set('uv', uvd * 9.0)
wimg = bpy.data.images.load(str(WATER / 'textures' / 'Water_Diffuse.png'))
mat_w = bpy.data.materials.new('Lake_Water'); mat_w.use_nodes = True
nt = mat_w.node_tree; p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
t = nt.nodes.new('ShaderNodeTexImage'); t.image = wimg
mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
nt.links.new(t.outputs['Color'], next(s for s in mx.inputs if s.identifier == 'A_Color'))
next(s for s in mx.inputs if s.identifier == 'B_Color').default_value = (*srgb_to_lin(hexc('#4a86d6')), 1)  # reference deep blue
nt.links.new(next(s for s in mx.outputs if s.identifier == 'Result_Color'), p.inputs['Base Color'])
p.inputs['Roughness'].default_value = 0.06; p.inputs['Alpha'].default_value = 0.84
if 'Specular IOR Level' in p.inputs: p.inputs['Specular IOR Level'].default_value = 0.6
water.data.materials.clear(); water.data.materials.append(mat_w)
REPORT['water'] = {'shapeKeys': len(keys), 'scale': list(water.scale), 'uvTiling': 9, 'tint': '#4a86d6', 'alpha': 0.84,
                   'actions': [a.name for a in bpy.data.actions]}

# ----------------------------------------------------------------------------- points of interest (site markers)
def poi(name, x, y, lift=1.0):
    z = max(float(fields(np.array([x], np.float32), np.array([y], np.float32))[0][0]), 0.0)
    o = bpy.data.objects.new(name, None); o.location = (x, y, z + lift); link(o); return o


POIS = {'POI_island': (-14, 10), 'POI_lake': (12, 18), 'POI_forest': (-62, 8), 'POI_mountain': (5, 236),
        'POI_beach': (40, -30), 'POI_rocks': (-8, -62)}
for name, (x, y) in POIS.items(): poi(name, x, y, 2.0 if name != 'POI_lake' else 0.5)
REPORT['pois'] = {k: list(v) for k, v in POIS.items()}

# ----------------------------------------------------------------------------- save + export
bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'IMANTAU-scene.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', export_image_format='WEBP', export_image_quality=88,
                          export_cameras=False, export_lights=False, export_apply=False, export_animations=True,
                          export_morph=True, export_morph_normal=False)
REPORT['output'] = str(OUT.relative_to(ROOT)); REPORT['outputBytes'] = OUT.stat().st_size; REPORT['seconds'] = round(time.time() - T0, 1)
(ROOT / 'work' / 'diagnostics' / 'scene.json').write_text(json.dumps(REPORT, indent=2), encoding='utf8')
print('SCENE_REPORT', json.dumps(REPORT))
