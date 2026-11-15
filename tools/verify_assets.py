"""Structural and byte-level checks; no writes to either original."""
import hashlib, io, json, math, struct, zipfile
from pathlib import Path
from PIL import Image
from pxr import Usd, UsdGeom
ROOT=Path(__file__).resolve().parents[1]
def read(path):
    raw=path.read_bytes();n=struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+n]),raw[28+n:]
a,old=read(ROOT/'IMANTAU.glb');b,new=read(ROOT/'work/IMANTAU-restored.glb')
assert new[:len(old)]==old
assert a['nodes']==b['nodes']
assert a['accessors']==b['accessors'][:len(a['accessors'])]
assert a['images']==b['images'][:len(a['images'])]
assert all(m==b['materials'][i] for i,m in enumerate(a['materials']) if i!=5)
stage=Usd.Stage.Open(str(ROOT.parent/'scene_pbr.usdz'))
usd_triangles=0;custom={}
for p in stage.Traverse():
    if p.GetTypeName()=='Mesh':usd_triangles+=sum(n-2 for n in UsdGeom.Mesh(p).GetFaceVertexCountsAttr().Get())
    for attr in p.GetAttributes():
        name=str(attr.GetName())
        if 'userProperties:' in name and 'blender:' not in name:
            custom.setdefault(name,set()).add(str(attr.Get()))
glb_triangles=sum(a['accessors'][p['indices']]['count']//3 for n in a['nodes'] if 'mesh'in n for p in a['meshes'][n['mesh']]['primitives'])
assert usd_triangles==glb_triangles
normals=[]
for m in a['meshes']:
    accessor=a['accessors'][m['primitives'][0]['attributes']['NORMAL']];view=a['bufferViews'][accessor['bufferView']];start=view.get('byteOffset',0)+accessor.get('byteOffset',0)
    for i in range(accessor['count']):
        v=struct.unpack_from('<fff',old,start+i*view.get('byteStride',12));normals.append(math.sqrt(sum(x*x for x in v)))
assert all(math.isfinite(x) for x in normals)
def pixels(payload):
    im=Image.open(io.BytesIO(payload)).convert('RGBA');return (im.size,hashlib.sha256(im.tobytes()).hexdigest())
source_images={}
with zipfile.ZipFile(ROOT.parent/'scene_pbr.usdz') as z:
    for name in z.namelist():
        if name.endswith('.png'):source_images.setdefault(pixels(z.read(name)),[]).append(name)
matched=[];converted=[]
for image in a['images']:
    v=a['bufferViews'][image['bufferView']];payload=old[v.get('byteOffset',0):v.get('byteOffset',0)+v['byteLength']]
    match=source_images.get(pixels(payload))
    (matched if match else converted).append({'name':image.get('name'),'source':match})
report={'originalBinaryPreserved':True,'originalNodesTransformsPreserved':True,'originalAccessorsPreserved':True,'sourceTriangles':usd_triangles,'glbTriangles':glb_triangles,'normalCount':len(normals),'normalLengthMin':min(normals),'normalLengthMax':max(normals),'originalImagesMatchingSourcePixels':matched,'convertedOrPackedImages':converted,'sourceCustomProperties':{k:sorted(v) for k,v in custom.items()}}
(ROOT/'work/diagnostics/verification.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf8')
print(json.dumps({k:v for k,v in report.items() if k not in ('originalImagesMatchingSourcePixels','convertedOrPackedImages','sourceCustomProperties')},indent=2))
print('Source pixel matches:',len(matched),'packed/converted:',len(converted),'custom property keys:',list(custom))
