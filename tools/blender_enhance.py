"""IMANTAU — Blender texture enhancement pass.

Run (Blender 4.2+ / 5.x, headless):
    blender -b --factory-startup --python tools/blender_enhance.py

Input : work/IMANTAU-restored.glb   (source-faithful GLB, see tools/restore_assets.py)
Output: public/scenes/IMANTAU-enhanced.glb  (web model used by the site)
        work/blender/*.png, work/blender/IMANTAU-enhanced.blend, work/diagnostics/enhance.json

What it does
  * Shore ("Moss Soil PBR") and mountain foot ground get a new baked base-colour map:
    authored texture + world-space meadow variation + shoreline sand / wet-mud band at
    the water line (z = -0.38) + fine grain. Both use the SAME world-space shader, so the
    former dark rectangle around the mountain now blends into the shore.
  * Everything else (geometry, UVs, normals, water transmission/volume, rocks, trees)
    is untouched. Images are exported as WebP (EXT_texture_webp) to cut download size.
"""
import json, time
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'work' / 'IMANTAU-restored.glb'
OUT = ROOT / 'public' / 'scenes' / 'IMANTAU-enhanced.glb'
WORK = ROOT / 'work' / 'blender'
WORK.mkdir(parents=True, exist_ok=True)
WATER_Z = -0.38


def lin(hex_rgb):
    """sRGB hex -> linear RGBA (ColorRamp / Mix work in linear space)."""
    def c(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    h = hex_rgb.lstrip('#')
    return (*(c(int(h[i:i + 2], 16)) for i in (0, 2, 4)), 1.0)


def mix(nodes, links, factor, a, b, blend='MIX'):
    n = nodes.new('ShaderNodeMix'); n.data_type = 'RGBA'; n.blend_type = blend; n.clamp_factor = True
    fin = n.inputs['Factor'] if 'Factor' in n.inputs else n.inputs[0]
    for sock, val in ((fin, factor),):
        if isinstance(val, (int, float)): sock.default_value = val
        else: links.new(val, sock)
    for ident, val in (('A_Color', a), ('B_Color', b)):
        sock = next(s for s in n.inputs if s.identifier == ident)
        if isinstance(val, tuple): sock.default_value = val
        else: links.new(val, sock)
    return next(s for s in n.outputs if s.identifier == 'Result_Color')


def noise(nodes, links, vector, scale, detail=3.0, roughness=0.5):
    n = nodes.new('ShaderNodeTexNoise'); n.noise_dimensions = '3D'
    n.inputs['Scale'].default_value = scale; n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = roughness
    links.new(vector, n.inputs['Vector'])
    return n.outputs['Fac']


def map_range(nodes, links, value, a, b, c, d):
    n = nodes.new('ShaderNodeMapRange'); n.clamp = True
    links.new(value, n.inputs['Value'])
    n.inputs['From Min'].default_value, n.inputs['From Max'].default_value = a, b
    n.inputs['To Min'].default_value, n.inputs['To Max'].default_value = c, d
    return n.outputs['Result']


def math(nodes, links, op, a, b):
    n = nodes.new('ShaderNodeMath'); n.operation = op
    for sock, val in zip(n.inputs, (a, b)):
        if isinstance(val, (int, float)): sock.default_value = val
        else: links.new(val, sock)
    return n.outputs['Value']


def build_ground_colour(mat, authored_weight, shoreline=True):
    """Returns (temporary nodes, colour socket) for the world-space ground shader."""
    nt = mat.node_tree; nodes, links = nt.nodes, nt.links
    before = set(nodes)
    principled = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    authored = principled.inputs['Base Color'].links[0].from_socket
    geo = nodes.new('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']
    sep = nodes.new('ShaderNodeSeparateXYZ'); links.new(pos, sep.inputs[0])
    z = sep.outputs['Z']

    # Meadow palette driven by large, soft patches (~5 m features).
    ramp = nodes.new('ShaderNodeValToRGB')
    links.new(noise(nodes, links, pos, 0.16, 4, 0.55), ramp.inputs['Fac'])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.34, lin('#3e5a2b')
    els[1].position, els[1].color = 0.52, lin('#5f8237')
    e = els.new(0.66); e.color = lin('#8d8e4c')
    e = els.new(0.78); e.color = lin('#a39a63')
    meadow = ramp.outputs['Color']
    # Keep the character of the authored texture.
    colour = mix(nodes, links, authored_weight, meadow, authored)
    # Medium tonal variation and fine grain (multiplied brightness).
    mid = map_range(nodes, links, noise(nodes, links, pos, 1.3, 3, 0.6), 0.3, 0.7, 0.86, 1.08)
    grain = map_range(nodes, links, noise(nodes, links, pos, 22.0, 2, 0.7), 0.3, 0.7, 0.9, 1.07)
    shade = math(nodes, links, 'MULTIPLY', mid, grain)
    val = nodes.new('ShaderNodeCombineColor'); [links.new(shade, val.inputs[i]) for i in range(3)]
    colour = mix(nodes, links, 1.0, colour, val.outputs['Color'], 'MULTIPLY')

    if not shoreline:
        return set(nodes) - before, colour, principled
    # Shoreline: perturb height so the band edge is organic, not a contour line.
    zn = math(nodes, links, 'ADD', z, map_range(nodes, links, noise(nodes, links, pos, 2.4, 2, 0.5), 0.3, 0.7, -0.05, 0.05))
    # The shore dips under the edges of the mountain-foot tile (Blender x -7..5, y 2.8..12);
    # those dips are not lake banks, so push them up out of the sand/damp range.
    x = sep.outputs['X']; y = sep.outputs['Y']
    inside = math(nodes, links, 'MULTIPLY',
                  math(nodes, links, 'MULTIPLY', math(nodes, links, 'GREATER_THAN', x, -7.6), math(nodes, links, 'LESS_THAN', x, 5.6)),
                  math(nodes, links, 'MULTIPLY', math(nodes, links, 'GREATER_THAN', y, 2.2), math(nodes, links, 'LESS_THAN', y, 12.6)))
    zn = math(nodes, links, 'ADD', zn, math(nodes, links, 'MULTIPLY', inside, 1.0))
    damp = map_range(nodes, links, zn, WATER_Z + 0.06, WATER_Z + 0.22, 0.0, 1.0)  # 0 at bank -> 1 inland
    damp_tint = mix(nodes, links, 1.0, colour, lin('#cfd2c4'), 'MULTIPLY')
    colour = mix(nodes, links, math(nodes, links, 'SUBTRACT', 1.0, damp), colour, damp_tint)
    sand = map_range(nodes, links, zn, WATER_Z + 0.09, WATER_Z - 0.01, 0.0, 1.0)
    colour = mix(nodes, links, sand, colour, lin('#a8977a'))
    wet = map_range(nodes, links, zn, WATER_Z - 0.03, WATER_Z - 0.16, 0.0, 1.0)
    colour = mix(nodes, links, wet, colour, lin('#6f6550'))
    return set(nodes) - before, colour, principled


def bake_ground(obj_name, uv_name, size, authored_weight, shoreline=True):
    ob = bpy.data.objects[obj_name]; me = ob.data; mat = me.materials[0]
    nt = mat.node_tree; nodes, links = nt.nodes, nt.links
    temp, colour, principled = build_ground_colour(mat, authored_weight, shoreline)
    out = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
    emit = nodes.new('ShaderNodeEmission'); links.new(colour, emit.inputs['Color'])
    links.new(emit.outputs['Emission'], out.inputs['Surface'])
    img = bpy.data.images.new(f'{obj_name}_enhanced_basecolor', size, size, alpha=False)
    img.colorspace_settings.name = 'sRGB'
    target = nodes.new('ShaderNodeTexImage'); target.image = img
    uvn = nodes.new('ShaderNodeUVMap'); uvn.uv_map = uv_name; links.new(uvn.outputs['UV'], target.inputs['Vector'])
    for n in nodes: n.select = False
    target.select = True; nodes.active = target
    me.uv_layers.active = me.uv_layers[uv_name]
    for o in bpy.context.view_layer.objects: o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    t = time.time()
    bpy.ops.object.bake(type='EMIT', margin=8, use_clear=True)
    took = time.time() - t
    img.filepath_raw = str(WORK / f'{obj_name.replace(" ", "_")}_basecolor.png'); img.file_format = 'PNG'; img.save()
    # Restore the PBR graph with the baked map as base colour; drop the bake-only nodes.
    links.new(principled.outputs['BSDF'], out.inputs['Surface'])
    links.new(target.outputs['Color'], principled.inputs['Base Color'])
    old = [l.from_node for l in principled.inputs['Base Color'].links]
    for n in list(temp) + [emit]: nodes.remove(n)
    for n in list(nodes):
        if n.type == 'TEX_IMAGE' and n is not target and not n.outputs['Color'].links and not n.outputs['Alpha'].links: nodes.remove(n)
    principled.inputs['Roughness'].default_value = max(principled.inputs['Roughness'].default_value, 0.88) if not principled.inputs['Roughness'].links else principled.inputs['Roughness'].default_value
    return {'object': obj_name, 'uv': uv_name, 'size': size, 'authoredWeight': authored_weight,  'shoreline': shoreline, 'bakeSeconds': round(took, 1), 'png': img.filepath_raw}


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SRC))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 4
report = {'source': SRC.name, 'bakes': []}
report['bakes'].append(bake_ground('Forested Shore', 'UVMap.001', 4096, 0.30))
report['bakes'].append(bake_ground('mountain_foot_ground', 'UVMap', 2048, 0.12, shoreline=False))
PINE_TINTS = ['#5b8a52', '#4d7d4f', '#66905a']  # multiplied with the light needle texture


def tint_needles():
    """The source pine-needle texture is a light yellow-green with no tint (USD diffuseColor =
    texture only), so pines read as frosted/white under daylight. Multiply by a deep pine green
    (exported as glTF baseColorFactor) and lower the specular so needles stop glinting."""
    done = []
    leaf_mats = [m for m in bpy.data.materials if m.name.startswith('Vegetation_Tint') and m.node_tree]
    leaf_mats = [m for m in leaf_mats if next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Alpha'].is_linked]
    for i, m in enumerate(sorted(leaf_mats, key=lambda m: m.name)):
        nt = m.node_tree; p = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        src = p.inputs['Base Color'].links[0].from_socket
        tint = lin(PINE_TINTS[i % len(PINE_TINTS)])
        out = mix(nt.nodes, nt.links, 1.0, src, tint, 'MULTIPLY')
        nt.links.new(out, p.inputs['Base Color'])
        p.inputs['Roughness'].default_value = 0.92
        if 'Specular IOR Level' in p.inputs: p.inputs['Specular IOR Level'].default_value = 0.2
        done.append({'material': m.name, 'tint': PINE_TINTS[i % len(PINE_TINTS)]})
    return done


report['needleTint'] = tint_needles()


def retint_mountain(obj_name='Mesh', uv='UVMap', size=2048):
    """Reference look: forested green slopes with grey granite outcrops. The scanned mountain
    texture is blue-grey everywhere; bake a version where darker texels (vegetation) turn pine
    green and bright texels (bare rock) stay neutral warm grey."""
    ob = bpy.data.objects[obj_name]; mat = ob.data.materials[0]; nt = mat.node_tree; nodes, links = nt.nodes, nt.links
    before = set(nodes)
    p = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED'); tex = p.inputs['Base Color'].links[0].from_socket
    bw = nodes.new('ShaderNodeRGBToBW'); links.new(tex, bw.inputs['Color'])
    veg = map_range(nodes, links, bw.outputs['Val'], 0.10, 0.30, 0.85, 0.0)
    warm = mix(nodes, links, 1.0, tex, tuple(v * 1.12 if i < 3 else v for i, v in enumerate(lin('#f1ece2'))), 'MULTIPLY')
    green = mix(nodes, links, 1.0, tex, tuple(v * 1.9 if i < 3 else v for i, v in enumerate(lin('#7fae5c'))), 'MULTIPLY')
    colour = mix(nodes, links, veg, warm, green)
    out = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
    emit = nodes.new('ShaderNodeEmission'); links.new(colour, emit.inputs['Color']); links.new(emit.outputs['Emission'], out.inputs['Surface'])
    img = bpy.data.images.new('mountain_enhanced_basecolor', size, size, alpha=False)
    target = nodes.new('ShaderNodeTexImage'); target.image = img
    uvn = nodes.new('ShaderNodeUVMap'); uvn.uv_map = uv; links.new(uvn.outputs['UV'], target.inputs['Vector'])
    for n in nodes: n.select = False
    target.select = True; nodes.active = target
    for o in bpy.context.view_layer.objects: o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='EMIT', margin=8, use_clear=True)
    img.filepath_raw = str(WORK / 'mountain_basecolor.png'); img.file_format = 'PNG'; img.save()
    links.new(p.outputs['BSDF'], out.inputs['Surface'])
    src_node = tex.node
    links.new(target.outputs['Color'], p.inputs['Base Color'])
    for n in (set(nodes) - before) - {target, uvn}: nodes.remove(n)
    if not src_node.outputs['Color'].links: nodes.remove(src_node)
    return {'object': obj_name, 'size': size}


def deep_blue_water():
    """Reference water: deep saturated blue, clear at the shallows. Volume Absorption colour /
    density export as KHR_materials_volume attenuationColor / attenuationDistance (=1/density)."""
    m = bpy.data.materials['Blue Lake_material']
    vol = next(n for n in m.node_tree.nodes if n.type == 'VOLUME_ABSORPTION')
    vol.inputs['Color'].default_value = lin('#2a6fc0')
    vol.inputs['Density'].default_value = 1 / 0.6
    return {'attenuationColor': '#2a6fc0', 'attenuationDistance': 0.6}


def densify_forest(target_new=2800, seed=7):
    """Reference: dense pine forest around the lake with clearings. Add linked copies of the
    source pines (same meshes/materials, so no new assets), dropped onto the shore / mountain-foot
    surface by ray casts. A low-frequency noise mask leaves meadows; trees stay above the bank."""
    import random
    from mathutils import Vector, Matrix, noise
    rnd = random.Random(seed)
    ground = {bpy.data.objects['Forested Shore'], bpy.data.objects['mountain_foot_ground']}
    pairs = []
    for root in ('shore_pines_0', 'shore_pines_1'):
        kids = sorted(bpy.data.objects[root].children, key=lambda o: o.name)
        by = {}
        for k in kids: by.setdefault(k.name.rsplit('_', 1)[0], []).append(k)
        pairs += [v for v in by.values() if len(v) == 2]
    occupied = {}
    def cell(x, y): return (int(x // 0.17), int(y // 0.17))
    for pr in pairs:
        t = pr[0].matrix_world.translation; occupied.setdefault(cell(t.x, t.y), True)
    coll = bpy.data.collections.new('forest_densified'); bpy.context.scene.collection.children.link(coll)
    root = bpy.data.objects.new('forest_densified', None); coll.objects.link(root)
    dg = bpy.context.evaluated_depsgraph_get(); scene = bpy.context.scene
    added = tries = 0
    while added < target_new and tries < target_new * 30:
        tries += 1
        x, y = rnd.uniform(-11.8, 11.8), rnd.uniform(-5.8, 17.8)
        if noise.noise(Vector((x * 0.22, y * 0.22, 3.1))) < -0.18: continue        # meadow clearing
        c = cell(x, y)
        if any((c[0] + i, c[1] + j) in occupied for i in (-1, 0, 1) for j in (-1, 0, 1)): continue
        hit, loc, nrm, _, ob, _ = scene.ray_cast(dg, Vector((x, y, 5)), Vector((0, 0, -1)))
        if not hit or ob not in ground or loc.z < WATER_Z + 0.12 or nrm.z < 0.8: continue
        src = rnd.choice(pairs); s = rnd.uniform(0.75, 1.35); rot = rnd.uniform(0, 6.2832)
        t0 = src[0].matrix_world.translation.copy()
        place = (Matrix.Translation((loc.x, loc.y, loc.z - 0.02)) @ Matrix.Rotation(rot, 4, 'Z')
                 @ Matrix.Scale(s, 4) @ Matrix.Translation(-t0))
        for part in src:
            o = part.copy(); coll.objects.link(o)
            o.parent = root; o.matrix_parent_inverse.identity()
            o.matrix_world = place @ part.matrix_world
        occupied[c] = True; added += 1
    return {'sourcePines': len(pairs), 'addedPines': added, 'seed': seed}


report['mountain'] = retint_mountain()
report['water'] = deep_blue_water()
report['forest'] = densify_forest()
bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'IMANTAU-enhanced.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', export_image_format='WEBP', export_image_quality=90,
                          export_cameras=False, export_lights=False, export_apply=False)
report['output'] = str(OUT.relative_to(ROOT)); report['outputBytes'] = OUT.stat().st_size
(ROOT / 'work' / 'diagnostics' / 'enhance.json').write_text(json.dumps(report, indent=2), encoding='utf8')
print('ENHANCE_REPORT', json.dumps(report))
