"""Restore source-authored shore textures and baked UVs; originals remain read-only."""
import hashlib, json, struct, zipfile
from pathlib import Path
from pxr import Usd, UsdGeom, Gf
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
source = ROOT.parent / 'scene_pbr.usdz'
original = ROOT / 'IMANTAU.glb'
raw = original.read_bytes()
jn = struct.unpack_from('<I', raw, 12)[0]
doc = json.loads(raw[20:20+jn])
binary = bytearray(raw[28+jn:])

def read_accessor(i):
    a=doc['accessors'][i]; v=doc['bufferViews'][a['bufferView']]
    components={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    fmt={5126:'f',5125:'I',5123:'H'}[a['componentType']]
    step=struct.calcsize(fmt)*components
    start=v.get('byteOffset',0)+a.get('byteOffset',0)
    return [struct.unpack_from('<'+fmt*components,binary,start+n*v.get('byteStride',step)) for n in range(a['count'])]

def add_view(data):
    while len(binary)%4: binary.append(0)
    idx=len(doc['bufferViews'])
    doc['bufferViews'].append({'buffer':0,'byteOffset':len(binary),'byteLength':len(data)})
    binary.extend(data)
    return idx

stage=Usd.Stage.Open(str(source))
mesh=UsdGeom.Mesh(stage.GetPrimAtPath('/scene/object_0007_0007_0/object_0007_0007_0'))
points=mesh.GetPointsAttr().Get()
indices=mesh.GetFaceVertexIndicesAttr().Get()
pv=UsdGeom.PrimvarsAPI(mesh)
st=pv.GetPrimvar('st').ComputeFlattened()
baked=pv.GetPrimvar('UVMap_002').ComputeFlattened()
world=UsdGeom.Xformable(mesh).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
# Match using transformed geometry AND UV, preserving seams. glTF's image origin is top-left.
lookup={}
uv_lookup={}
for corner,idx in enumerate(indices):
    p=world.Transform(Gf.Vec3d(*points[idx]))
    key=tuple(round(float(x),4) for x in (p[0],p[2],-p[1],st[corner][0],1-st[corner][1]))
    uv=(float(baked[corner][0]),1-float(baked[corner][1]))
    if key in lookup: assert max(abs(a-b) for a,b in zip(lookup[key],uv))<1e-5
    lookup[key]=uv
    uv_lookup[tuple(round(float(x),5) for x in (st[corner][0],1-st[corner][1]))]=(tuple(float(x) for x in (p[0],p[2],-p[1])),uv)
prim=doc['meshes'][5]['primitives'][0]
positions=read_accessor(prim['attributes']['POSITION'])
old_uv=read_accessor(prim['attributes']['TEXCOORD_0'])
restored=[]
for pos,uv in zip(positions,old_uv):
    key=tuple(round(float(x),4) for x in (*pos,*uv))
    source_pos,source_uv=uv_lookup[tuple(round(float(x),5) for x in uv)]
    assert max(abs(a-b) for a,b in zip(pos,source_pos))<0.0001, ('Unmatched source vertex',key)
    restored.extend(source_uv)
view=add_view(struct.pack('<'+'f'*len(restored),*restored))
uv_index=len(doc['accessors'])
doc['accessors'].append({'bufferView':view,'componentType':5126,'count':len(positions),'type':'VEC2'})
prim['attributes']['TEXCOORD_1']=uv_index
sampler=len(doc.setdefault('samplers',[]))
doc['samplers'].append({'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':10497})
with zipfile.ZipFile(source) as archive:
    for filename,slot in [('Procedural base color.png','baseColorTexture'),('Procedural tangent normals.png','normalTexture')]:
        payload=archive.read('textures/'+filename)
        image=len(doc['images']); doc['images'].append({'bufferView':add_view(payload),'mimeType':'image/png','name':filename})
        texture=len(doc['textures']); doc['textures'].append({'source':image,'sampler':sampler})
        target=doc['materials'][5]['pbrMetallicRoughness'] if slot=='baseColorTexture' else doc['materials'][5]
        target[slot]={'index':texture,'texCoord':1}
doc['buffers'][0]['byteLength']=len(binary)
while len(binary)%4: binary.append(0)
encoded=json.dumps(doc,separators=(',',':')).encode()
while len(encoded)%4: encoded+=b' '
result=struct.pack('<III',0x46546c67,2,28+len(encoded)+len(binary))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+struct.pack('<II',len(binary),0x004e4942)+binary
out=ROOT/'work/IMANTAU-restored.glb';out.write_bytes(result)
report={'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'originalGlbSha256':hashlib.sha256(raw).hexdigest(),'restoredSha256':hashlib.sha256(result).hexdigest(),'matchedShoreVertices':len(positions),'sourceShoreTriangles':len(indices)//3,'glbShoreTriangles':len(read_accessor(prim['indices']))//3,'sourceMeshInstances':sum(p.GetTypeName()=='Mesh' for p in stage.Traverse()),'glbMeshInstances':sum('mesh' in n for n in doc['nodes']),'sourceAxis':'Z','webAxis':'Y','conversion':'(x, y, z) → (x, z, -y)','originalBytes':len(raw),'restoredBytes':len(result),'preserved':'All original binary buffers, transforms, normals, other materials and original UVs. Source images copied byte-for-byte. No generated replacement textures.'}
(ROOT/'work/diagnostics/restoration.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report,indent=2))
# Diagnostic contact sheet, not a replacement asset.
sheet=Image.new('RGB',(1000,540),'#eeeae2');draw=ImageDraw.Draw(sheet)
for i,name in enumerate(['Procedural base color.png','Procedural tangent normals.png']):
    im=Image.open(ROOT/'work/diagnostics/textures'/name)
    sheet.paste(ImageOps.contain(im.convert('RGB'),(480,480)),(10+i*500,40))
    draw.text((10+i*500,10),f'{name} {im.size}',fill='black')
sheet.save(ROOT/'work/diagnostics/shore-textures.jpg')
