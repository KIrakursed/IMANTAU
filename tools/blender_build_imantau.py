"""IMANTAU — build the real-location scene in Blender from prepared geodata.

    python tools/geo_prepare.py                     # once, after tools/geo_fetch.sh
    blender -b --factory-startup --python tools/blender_build_imantau.py

Uses work/geo/prepared/{height.npy, texture.png, trees.npy, scene.json} plus the provided
pine (assets/source/pine-tree) and water (assets/source/water-animation) assets.
Output: public/scenes/IMANTAU-real.glb, work/blender/IMANTAU-real.blend, work/diagnostics/real-scene.json
Blender is Z-up; glTF export converts to Y-up (x, y, z) -> (x, z, -y).
"""
import json, math, time
from pathlib import Path
import numpy as np
import bpy, bmesh

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / 'work' / 'geo' / 'prepared'
PINE = ROOT / 'assets' / 'source' / 'pine-tree'
WATER = ROOT / 'assets' / 'source' / 'water-animation'
OUT = ROOT / 'public' / 'scenes' / 'IMANTAU-real.glb'
WORK = ROOT / 'work' / 'blender'; WORK.mkdir(parents=True, exist_ok=True)
S = json.loads((P / 'scene.json').read_text(encoding='utf8'))
REPORT = {'unitMetres': S['unitMetres'], 'verticalExaggeration': S['verticalExaggeration'], 'lakeLevelM': S['lakeLevelM']}
T0 = time.time()


def srgb_to_lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]


def material(name, image=None, color=None, rough=0.9, alpha_clip=False, normal_img=None, specular=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Roughness'].default_value = rough
    if specular is not None and 'Specular IOR Level' in p.inputs: p.inputs['Specular IOR Level'].default_value = specular
    if image is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image; nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
        if alpha_clip:
            r = nt.nodes.new('ShaderNodeMath'); r.operation = 'ROUND'
            nt.links.new(t.outputs['Alpha'], r.inputs[0]); nt.links.new(r.outputs['Value'], p.inputs['Alpha'])
    elif color is not None:
        p.inputs['Base Color'].default_value = (*srgb_to_lin(color), 1)
    if normal_img is not None:
        normal_img.colorspace_settings.name = 'Non-Color'
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = normal_img
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    return m


def link(ob): bpy.context.scene.collection.objects.link(ob); return ob


bpy.ops.wm.read_factory_settings(use_empty=True)

# ----------------------------------------------------------------------------- terrain (real DEM)
H = np.load(P / 'height.npy'); rows, cols = H.shape
gx0, gx1, gy1, gy0 = S['extent']              # [west, east, south, north] in units
xs = np.linspace(gx0, gx1, cols, dtype=np.float32); ys = np.linspace(gy0, gy1, rows, dtype=np.float32)
GX, GY = np.meshgrid(xs, ys)
verts = np.stack([GX.ravel(), GY.ravel(), H.ravel()], 1)
idx = np.arange(rows * cols).reshape(rows, cols)
quads = np.stack([idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel(), idx[:-1, :-1].ravel()], 1)
me = bpy.data.meshes.new('Terrain'); me.from_pydata(verts.tolist(), [], quads.tolist())
uv = me.uv_layers.new(name='UVMap')
lv = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', lv)
col = lv % cols; row = lv // cols
uv.data.foreach_set('uv', np.stack([col / (cols - 1), 1 - row / (rows - 1)], 1).astype(np.float32).ravel())
me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
tex = bpy.data.images.load(str(P / 'texture.png'))
me.materials.append(material('Terrain', image=tex, rough=0.96, specular=0.25))
link(bpy.data.objects.new('Terrain', me))
REPORT['terrain'] = {'grid': [rows, cols], 'vertices': len(me.vertices)}

# ----------------------------------------------------------------------------- pine (provided asset)
bpy.ops.import_scene.fbx(filepath=str(PINE / 'source' / 'Tree.fbx'))
leaves = bpy.data.objects['Leaves/001']; trunk = bpy.data.objects['Trank.001']
img_l = bpy.data.images.load(str(PINE / 'textures' / 'Leavs_basecolor_.tga.png'))
img_o = bpy.data.images.load(str(PINE / 'textures' / 'Leavs_Opacity.png'))
w, hh = img_l.size
L = np.array(img_l.pixels[:], np.float32).reshape(hh, w, 4)
O = np.array(img_o.pixels[:], np.float32).reshape(hh, w, img_o.channels)[..., 0]
lum = L[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32); lum = lum / max(lum[O > 0.5].mean(), 1e-3)
# Scots pine needles of the Kokshetau massif: deep blue-green, recoloured from the olive source texture.
pine = np.array([0.20, 0.33, 0.19], np.float32); tip = np.array([0.33, 0.46, 0.27], np.float32)
needles = (pine * (1 - lum[..., None] * 0.3) + tip * lum[..., None] * 0.3) * np.clip(lum, 0.6, 1.3)[..., None]
nimg = bpy.data.images.new('pine_needles', w, hh, alpha=True)
nimg.pixels.foreach_set(np.dstack([np.clip(needles, 0, 1), O]).astype(np.float32).ravel())
nimg.filepath_raw = str(WORK / 'pine_needles_real.png'); nimg.file_format = 'PNG'; nimg.save()
leaves.data.materials.clear(); leaves.data.materials.append(material('Pine_Needles', image=nimg, rough=0.92, alpha_clip=True, specular=0.2))
trunk.data.materials.clear(); trunk.data.materials.append(material('Pine_Bark', image=bpy.data.images.load(str(PINE / 'textures' / 'Trank_basecolor.tga.png')),
                                                                  rough=0.95, normal_img=bpy.data.images.load(str(PINE / 'textures' / 'Trank_normal.tga.png'))))
src_faces = len(leaves.data.polygons)
for o in bpy.context.view_layer.objects: o.select_set(o == leaves)
bpy.context.view_layer.objects.active = leaves
dec = leaves.modifiers.new('decimate', 'DECIMATE'); dec.ratio = 0.17
bpy.ops.object.modifier_apply(modifier=dec.name)
for o in bpy.context.view_layer.objects: o.select_set(o in (leaves, trunk))
bpy.ops.object.join(); pine_obj = leaves; pine_obj.name = 'Pine'; pine_obj.data.name = 'Pine'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
pz = min(v.co.z for v in pine_obj.data.vertices)
tris = sum(len(p.vertices) - 2 for p in pine_obj.data.polygons)
TREE = 0.36   # 3.08-unit asset -> ~1.1 units (~45 m incl. the 2.5x vertical exaggeration)
trees = np.load(P / 'trees.npy'); rng = np.random.default_rng(5)
forest = link(bpy.data.objects.new('Forest', None))
for i, (x, y, z, s) in enumerate(trees):
    o = pine_obj.copy(); o.name = f'Pine_{i:05d}'
    sc = float(TREE * s); o.scale = (sc, sc, sc * float(rng.uniform(0.95, 1.2)))
    o.rotation_euler = (0, 0, float(rng.uniform(0, 6.283)))
    o.location = (float(x), float(y), float(z) - pz * sc - 0.05)
    o.parent = forest; link(o)
bpy.data.objects.remove(pine_obj)
REPORT['forest'] = {'trees': int(len(trees)), 'trianglesPerTree': tris, 'sourceNeedleFaces': src_faces}

# ----------------------------------------------------------------------------- buildings (OpenStreetMap footprints)
walls = material('Walls', color='#d9d2c3', rough=0.85)
roofs = [material('Roof_Grey', color='#8c8f93', rough=0.6), material('Roof_Red', color='#9a4a3a', rough=0.7),
         material('Roof_Green', color='#5b7a5e', rough=0.7), material('Roof_Blue', color='#4f6f8f', rough=0.65)]
bm = bmesh.new(); brng = np.random.default_rng(3)
for b in S['buildings']:
    ring = b['ring']
    area = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) / 2
    if abs(area) < 1e-4: continue
    if area < 0: ring = ring[::-1]
    base = b['base'] - 0.05; top = b['base'] + max(b['h'], 0.18)
    low = [bm.verts.new((x, y, base)) for x, y in ring]; high = [bm.verts.new((x, y, top)) for x, y in ring]
    n = len(ring)
    for i in range(n):
        f = bm.faces.new((low[i], low[(i + 1) % n], high[(i + 1) % n], high[i])); f.material_index = 0
    try:
        f = bm.faces.new(high); f.material_index = 1 + int(brng.integers(0, len(roofs)))
    except ValueError:
        pass
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
bme = bpy.data.meshes.new('Buildings'); bm.to_mesh(bme); bm.free()
bme.materials.append(walls); [bme.materials.append(r) for r in roofs]
link(bpy.data.objects.new('Buildings', bme))
REPORT['buildings'] = len(S['buildings'])

# ----------------------------------------------------------------------------- water (provided asset) over the real lake
bpy.ops.import_scene.fbx(filepath=str(WATER / 'source' / 'Water_Animation.fbx'))
water = bpy.data.objects['Water Export']; water.name = 'Lake_Water'; water.data.name = 'Lake_Water'
if water.animation_data and water.animation_data.action:
    act = water.animation_data.action; water.animation_data.action = None; bpy.data.actions.remove(act)
x0, y0, x1, y1 = S['lakeBBox']
water.location = ((x0 + x1) / 2, (y0 + y1) / 2, 0.0)
water.scale = ((x1 - x0) / 100 * 1.04, (y1 - y0) / 100 * 1.04, 0.012)   # calm lake ripple
uvw = water.data.uv_layers[0]; uvd = np.empty(len(uvw.data) * 2, np.float32); uvw.data.foreach_get('uv', uvd); uvw.data.foreach_set('uv', uvd * 36.0)
mat_w = bpy.data.materials.new('Lake_Water'); mat_w.use_nodes = True
nt = mat_w.node_tree; p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
t = nt.nodes.new('ShaderNodeTexImage'); t.image = bpy.data.images.load(str(WATER / 'textures' / 'Water_Diffuse.png'))
mx = nt.nodes.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1.0
nt.links.new(t.outputs['Color'], next(s for s in mx.inputs if s.identifier == 'A_Color'))
next(s for s in mx.inputs if s.identifier == 'B_Color').default_value = (*srgb_to_lin('#3f78b8'), 1)
nt.links.new(next(s for s in mx.outputs if s.identifier == 'Result_Color'), p.inputs['Base Color'])
p.inputs['Roughness'].default_value = 0.05; p.inputs['Alpha'].default_value = 0.9
water.data.materials.clear(); water.data.materials.append(mat_w)
REPORT['water'] = {'shapeKeys': len(water.data.shape_keys.key_blocks) if water.data.shape_keys else 0, 'bbox': S['lakeBBox']}

# ----------------------------------------------------------------------------- POIs (real locations)
for name, (x, y, z) in S['pois'].items():
    o = bpy.data.objects.new(name, None); o.location = (x, y, z); link(o)
REPORT['pois'] = S['pois']

bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'IMANTAU-real.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', export_image_format='WEBP', export_image_quality=86,
                          export_cameras=False, export_lights=False, export_apply=False, export_animations=True,
                          export_morph=True, export_morph_normal=False)
REPORT['output'] = str(OUT.relative_to(ROOT)); REPORT['outputBytes'] = OUT.stat().st_size; REPORT['seconds'] = round(time.time() - T0, 1)
(ROOT / 'work' / 'diagnostics' / 'real-scene.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False), encoding='utf8')
print('REAL_REPORT', json.dumps({k: v for k, v in REPORT.items() if k != 'pois'}))
