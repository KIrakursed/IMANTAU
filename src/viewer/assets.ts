import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const lowPower=()=>matchMedia('(pointer:coarse)').matches||innerWidth<900
export interface Landscape { root:THREE.Group; mixer:THREE.AnimationMixer }

/** 512px seamless procedural grass/stone albedo. Repeated 180x for close-range sharpness. */
function createCrispDetailTexture(renderer:THREE.WebGLRenderer){
  const size=512,canvas=document.createElement('canvas')
  canvas.width=size;canvas.height=size
  const ctx=canvas.getContext('2d')
  if(!ctx)return null
  const image=ctx.createImageData(size,size),data=image.data
  const hash=(x:number,y:number,seed:number)=>{
    const n=Math.sin(x*127.1+y*311.7+seed*74.7)*43758.5453
    return n-Math.floor(n)
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4
    const n=hash(x,y,1),coarse=hash(x>>2,y>>2,2),grain=hash(x*3,y*5,3)
    const blade=Math.max(0,Math.sin((x*0.71+y*0.19)+coarse*5))*0.16
    const stone=Math.max(0,Math.sin((x*0.13-y*0.31)+n*8))*0.12
    const value=0.72+n*0.18+coarse*0.07+grain*0.06
    data[i]=Math.min(255,Math.round(112+value*52+blade*35))
    data[i+1]=Math.min(255,Math.round(118+value*48+stone*24))
    data[i+2]=Math.min(255,Math.round(103+value*42+grain*16))
    data[i+3]=255
  }
  ctx.putImageData(image,0,0)
  // Add sparse fine grass/rock strokes; opposite edges remain seamless via wrapped shader sampling.
  ctx.globalAlpha=.16
  for(let i=0;i<1800;i++){
    const x=hash(i,3,7)*size,y=hash(i,9,8)*size
    ctx.strokeStyle=i%3?'#d4d0a5':'#343c2d'
    ctx.lineWidth=.5+hash(i,5,9)*1.2
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+1.5+hash(i,8,10)*3,y-2+hash(i,4,11)*4);ctx.stroke()
  }
  const texture=new THREE.CanvasTexture(canvas)
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping
  texture.repeat.set(180,180)
  texture.colorSpace=THREE.SRGBColorSpace
  texture.anisotropy=renderer.capabilities.getMaxAnisotropy()
  texture.generateMipmaps=true
  texture.minFilter=THREE.LinearMipmapLinearFilter
  texture.magFilter=THREE.LinearFilter
  texture.needsUpdate=true
  return texture
}

/** Blend crisp triplanar detail into the satellite albedo; steep slopes expose stone detail. */
function improveTerrainMaterial(mesh:THREE.Mesh,renderer:THREE.WebGLRenderer,detail:THREE.Texture){
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material]
  for(const material of materials){
    if(!(material instanceof THREE.MeshStandardMaterial))continue
    const maxAnisotropy=renderer.capabilities.getMaxAnisotropy()
    const textureSlots=['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap','bumpMap','alphaMap','displacementMap'] as const
    for(const slot of textureSlots){
      const texture=material[slot]
      if(texture){texture.anisotropy=maxAnisotropy;texture.needsUpdate=true}
    }
    if(material.map){
      material.map.minFilter=THREE.LinearMipmapLinearFilter
      material.map.magFilter=THREE.LinearFilter
    }
    material.bumpMap=null
    material.roughness=Math.max(material.roughness,.82)
    material.metalness=Math.min(material.metalness,.04)
    material.onBeforeCompile=(shader)=>{
      shader.uniforms.uTerrainDetail={value:detail}
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>',`#include <common>
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;`)
        .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
          vTerrainWorldPos=(modelMatrix*vec4(transformed,1.0)).xyz;
          vTerrainWorldNormal=normalize(mat3(modelMatrix)*objectNormal);`)
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>',`#include <common>
          uniform sampler2D uTerrainDetail;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;
          vec3 imantauTriplanar(sampler2D tex,vec3 p,vec3 n){
            vec3 w=pow(abs(normalize(n)),vec3(4.0));
            w/=max(w.x+w.y+w.z,0.0001);
            vec3 x=texture2D(tex,p.zy).rgb;
            vec3 y=texture2D(tex,p.xz).rgb;
            vec3 z=texture2D(tex,p.xy).rgb;
            return x*w.x+y*w.y+z*w.z;
          }`)
        .replace('#include <map_fragment>',`#include <map_fragment>
          vec3 terrainN=normalize(vTerrainWorldNormal);
          // 180 repeats over the authored 380x440m terrain footprint.
          vec3 terrainP=vTerrainWorldPos*0.40909;
          vec3 detailAlbedo=imantauTriplanar(uTerrainDetail,terrainP,terrainN);
          float slopeRock=1.0-smoothstep(0.58,0.78,terrainN.y);
          vec3 grassDetail=diffuseColor.rgb*(0.82+detailAlbedo*0.34);
          vec3 stoneBase=vec3(0.43,0.43,0.39);
          vec3 stoneDetail=stoneBase*(0.72+detailAlbedo*0.58);
          diffuseColor.rgb=mix(grassDetail,stoneDetail,slopeRock);`)
    }
    material.customProgramCacheKey=()=> 'imantau-terrain-triplanar-detail-v3'
    material.needsUpdate=true
  }
}

/** Conservative camera clearance over a narrow ridge; ignores out-of-bounds samples. */
export function getSafeRidgeCameraY(
  getHeightAtXZ:(x:number,z:number)=>number|null,
  x:number,z:number,eyeHeight=2.5,radius=1.5,
){
  const samples=[
    getHeightAtXZ(x,z),getHeightAtXZ(x,z-radius),getHeightAtXZ(x,z+radius),
    getHeightAtXZ(x+radius,z),getHeightAtXZ(x-radius,z),
  ].filter((height):height is number=>height!==null&&Number.isFinite(height))
  return samples.length?Math.max(...samples)+eyeHeight:null
}

/** Keep the Cardboard camera above the sampled terrain instead of clipping through steep slopes. */
export function getSafeTeleportPosition(hitPoint:THREE.Vector3,hitNormal?:THREE.Vector3|null,eyeHeight=4.8){
  const safe=hitPoint.clone()
  safe.y+=eyeHeight
  if(hitNormal)safe.addScaledVector(hitNormal.clone().normalize(),.35)
  return safe
}



/** Lower GLB terrain vertices beneath the water surface inside the lake basin. */
function lowerLakeBed(mesh:THREE.Mesh,waterLevel=.02,bedLevel=-.35){
  mesh.updateMatrixWorld(true)
  const position=mesh.geometry.getAttribute('position')
  const inverse=mesh.matrixWorld.clone().invert()
  const world=new THREE.Vector3(),local=new THREE.Vector3()
  const ellipse=(x:number,z:number,cx:number,cz:number,rx:number,rz:number,angle:number)=>{
    const c=Math.cos(angle),s=Math.sin(angle),dx=x-cx,dz=z-cz
    const u=(c*dx+s*dz)/rx,v=(-s*dx+c*dz)/rz
    return Math.sqrt(u*u+v*v)-1
  }
  let changed=false
  for(let i=0;i<position.count;i++){
    local.fromBufferAttribute(position,i)
    world.copy(local).applyMatrix4(mesh.matrixWorld)
    const x=world.x,z=world.z
    const lake=Math.min(
      ellipse(x,z,0,-5,48,26,0),
      ellipse(x,z,52,-38,40,12,-.4887),
      ellipse(x,z,30,14,20,13,0),
      ellipse(x,z,-62,-50,20,5,-.1745)
    )
    const onIsland=ellipse(x,z,-14,-10,13,5.5,.1745)<=0
      ||ellipse(x,z,40,-30,3.2,2.2,-.3491)<=0
    if(lake<=0&&!onIsland&&world.y>bedLevel){
      world.y=Math.min(bedLevel,waterLevel-.35)
      world.applyMatrix4(inverse)
      position.setXYZ(i,world.x,world.y,world.z)
      changed=true
    }
  }
  if(changed){
    position.needsUpdate=true
    mesh.geometry.computeVertexNormals()
    mesh.geometry.computeBoundingBox()
    mesh.geometry.computeBoundingSphere()
  }
}

/** Clip the imported rectangular water card to the lake shoreline authored in Blender. */
function applyLakeShorelineMask(material:THREE.MeshStandardMaterial){
  material.transparent=true
  material.opacity=.84
  material.depthWrite=false
  material.side=THREE.DoubleSide
  material.onBeforeCompile=(shader)=>{
    shader.vertexShader=shader.vertexShader
      .replace('#include <common>',`#include <common>
        varying vec3 vImantauWaterWorld;`)
      .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
        vImantauWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz;`)
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>',`#include <common>
        varying vec3 vImantauWaterWorld;
        float imantauEllipse(vec2 p,vec2 center,vec2 radii,float angle){
          float c=cos(angle),s=sin(angle);
          vec2 q=p-center;
          q=vec2(c*q.x+s*q.y,-s*q.x+c*q.y);
          return length(q/radii)-1.0;
        }`)
      .replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
        vec2 lakeP=vec2(vImantauWaterWorld.x,vImantauWaterWorld.z);
        float lakeD=min(
          min(imantauEllipse(lakeP,vec2(0.0,-5.0),vec2(48.0,26.0),0.0),
              imantauEllipse(lakeP,vec2(52.0,-38.0),vec2(40.0,12.0),-0.4887)),
          min(imantauEllipse(lakeP,vec2(30.0,14.0),vec2(20.0,13.0),0.0),
              imantauEllipse(lakeP,vec2(-62.0,-50.0),vec2(20.0,5.0),-0.1745))
        );
        if(lakeD>0.0) discard;`)
      .replace('#include <color_fragment>',`#include <color_fragment>
        diffuseColor.rgb*=vec3(0.82,0.94,0.96);`)
  }
  material.customProgramCacheKey=()=> 'imantau-lake-shoreline-mask-v1'
  material.needsUpdate=true
}

/** Loads the Blender-built scene (tools/blender_build_scene.py). */
export async function loadLandscape(progress:(n:number)=>void,renderer:THREE.WebGLRenderer):Promise<Landscape> {
  const gltf=await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'scenes/IMANTAU-real.glb',e=>progress(e.total?e.loaded/e.total:0))
  const root=gltf.scene
  root.updateMatrixWorld(true)
  const detailTexture=createCrispDetailTexture(renderer)
  const uses=new Map<string,THREE.Mesh[]>()
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return
    object.castShadow=true;object.receiveShadow=true
    const materials=Array.isArray(object.material)?object.material:[object.material]
    for(const material of materials){
      if(material instanceof THREE.Material){
        const maxAnisotropy=renderer.capabilities.getMaxAnisotropy()
        for(const value of Object.values(material)){
          if(value instanceof THREE.Texture)value.anisotropy=maxAnisotropy
        }
      }
      if(material.name==='Lake_Water'&&material instanceof THREE.MeshStandardMaterial){
        object.castShadow=false;object.receiveShadow=false;object.renderOrder=1
        material.envMapIntensity=1.35
        material.metalness=.12;material.roughness=.12
        material.polygonOffset=true;material.polygonOffsetFactor=-1;material.polygonOffsetUnits=-1
        applyLakeShorelineMask(material)
      }
      if(material.name==='Terrain'&&material instanceof THREE.MeshStandardMaterial){
        object.castShadow=false
        lowerLakeBed(object)
        if(detailTexture)improveTerrainMaterial(object,renderer,detailTexture)
      }
    }
    const materialKey=materials.map(m=>m.uuid).join(',')
    const key=object.geometry.uuid+'|'+materialKey
    const list=uses.get(key)??[];list.push(object);uses.set(key,list)
  })
  // The thousands of pines (and other repeated meshes) share geometry: draw each once per material.
  for(const meshes of uses.values()){
    if(meshes.length<8)continue
    const {geometry,material}=meshes[0]
    const instance=new THREE.InstancedMesh(geometry,material,meshes.length)
    instance.name=meshes[0].name.replace(/_\d+$/,'')+'_instances';instance.castShadow=true;instance.receiveShadow=true
    meshes.forEach((mesh,i)=>{instance.setMatrixAt(i,mesh.matrixWorld);mesh.removeFromParent()})
    // Phones draw a random half of the forest (instances are stored in random order).
    if(lowPower())instance.count=Math.ceil(meshes.length*.8)
    instance.instanceMatrix.needsUpdate=true;instance.computeBoundingSphere();root.add(instance)
  }
  // Water waves: only the shape-key (morph weight) clip from the provided water asset.
  const mixer=new THREE.AnimationMixer(root)
  for(const clip of gltf.animations){
    if(!clip.tracks.every(track=>track.name.endsWith('.morphTargetInfluences')))continue
    const action=mixer.clipAction(clip);action.timeScale=.45;action.play()
  }
  return {root,mixer}
}

export function disposeScene(root:THREE.Object3D){
  const geometries=new Set<THREE.BufferGeometry>(), materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>()
  root.traverse(o=>{
    if(o instanceof THREE.Mesh||o instanceof THREE.Sprite){
      if(o instanceof THREE.Mesh)geometries.add(o.geometry)
      for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m)
    }
  })
  materials.forEach(m=>{Object.values(m).forEach(v=>{if(v instanceof THREE.Texture)textures.add(v)});m.dispose()})
  textures.forEach(t=>t.dispose());geometries.forEach(g=>g.dispose())
}
