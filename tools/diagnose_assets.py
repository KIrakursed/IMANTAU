"""Read-only USDZ/GLB inspection. Run with Pixar usd-core on PYTHONPATH."""
import json, struct, hashlib, zipfile
from pathlib import Path
from collections import Counter
from pxr import Usd, UsdGeom

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'scene_pbr.usdz'
OUT = ROOT / 'work' / 'diagnostics'
OUT.mkdir(parents=True, exist_ok=True)
stage = Usd.Stage.Open(str(SOURCE))
report = {'source':str(SOURCE),'hash':hashlib.sha256(SOURCE.read_bytes()).hexdigest(), 'axis':str(UsdGeom.GetStageUpAxis(stage)), 'metersPerUnit':UsdGeom.GetStageMetersPerUnit(stage), 'types':dict(Counter(str(p.GetTypeName()) for p in stage.Traverse())), 'materials':[], 'lights':[], 'meshes':[]}
for p in stage.Traverse():
    typ=str(p.GetTypeName())
    if typ in ('Material','Shader') or 'Light' in typ:
        item={'path':str(p.GetPath()),'type':typ,'attributes':{str(a.GetName()):{'value':str(a.Get()),'connections':[str(c) for c in a.GetConnections()]} for a in p.GetAttributes()}}
        report['lights' if 'Light' in typ else 'materials'].append(item)
    if typ=='Mesh':
        mesh=UsdGeom.Mesh(p)
        report['meshes'].append({'path':str(p.GetPath()),'points':len(mesh.GetPointsAttr().Get() or []),'faces':len(mesh.GetFaceVertexCountsAttr().Get() or []),'primvars':[str(x.GetPrimvarName()) for x in UsdGeom.PrimvarsAPI(p).GetPrimvars()], 'binding':[str(x) for x in p.GetRelationship('material:binding').GetTargets()]})
data=(ROOT/'IMANTAU.glb').read_bytes()
n=struct.unpack_from('<I',data,12)[0]; gltf=json.loads(data[20:20+n])
report['glb']={'hash':hashlib.sha256(data).hexdigest(),'nodes':len(gltf['nodes']),'meshes':len(gltf['meshes']),'materials':gltf.get('materials'), 'extensions':gltf.get('extensionsUsed'), 'images':gltf.get('images'), 'primitives':[{'name':m.get('name'),'primitives':m['primitives']} for m in gltf['meshes']], 'externalBuffers':[b for b in gltf.get('buffers',[]) if 'uri' in b]}
(OUT/'assets.json').write_text(json.dumps(report,indent=2),encoding='utf8')
with zipfile.ZipFile(SOURCE) as z:
    for name in z.namelist():
        if name.startswith('textures/'):
            target=OUT/name; target.parent.mkdir(exist_ok=True);target.write_bytes(z.read(name))
print(json.dumps({k:v for k,v in report.items() if k not in ('materials','meshes','glb')},indent=2))
print('GLB materials:',json.dumps(gltf['materials'],indent=2))
print('Wrote',OUT/'assets.json')
