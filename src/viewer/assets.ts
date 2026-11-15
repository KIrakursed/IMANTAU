import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const lowPower=()=>matchMedia('(pointer:coarse)').matches||innerWidth<900
export interface Landscape { root:THREE.Group; mixer:THREE.AnimationMixer }

/** 512px periodic procedural microtexture. Periodic hash avoids seams on all four edges. */
function createCrispDetailTexture(renderer:THREE.WebGLRenderer){
  const size=512,canvas=document.createElement('canvas')
  canvas.width=size;canvas.height=size
  const ctx=canvas.getContext('2d')
  if(!ctx)return null
  const image=ctx.createImageData(size,size),data=image.data
  const wrap=(v:number)=>((v%size)+size)%size
  const hash=(x:number,y:number,seed:number)=>{
    const xx=wrap(x),yy=wrap(y)
    const n=Math.sin(xx*127.1+yy*311.7+seed*74.7)*43758.5453
    return n-Math.floor(n)
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4
    const n=hash(x,y,1),coarse=hash(x>>2,y>>2,2),grain=hash(x*3,y*5,3)
    const wave=Math.sin((x*0.71+y*0.19)+coarse*5)*.035
    const value=.72+n*.18+coarse*.07+grain*.06+wave
    data[i]=Math.min(255,Math.round(112+value*52))
    data[i+1]=Math.min(255,Math.round(118+value*48))
    data[i+2]=Math.min(255,Math.round(103+value*42))
    data[i+3]=255
  }
  ctx.putImageData(image,0,0)
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
    material.bumpMap=detail
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
          float slopeRock=smoothstep(0.25,0.42,1.0-terrainN.y);
          vec3 grassDetail=diffuseColor.rgb*(0.82+detailAlbedo*0.34);
          vec3 stoneBase=vec3(0.43,0.43,0.39);
          vec3 stoneDetail=stoneBase*(0.72+detailAlbedo*0.58);
          diffuseColor.rgb=mix(grassDetail,stoneDetail,slopeRock);`)
    }
    material.customProgramCacheKey=()=> 'imantau-terrain-triplanar-detail-v4'
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
function lowerLakeBed(mesh:THREE.Mesh,waterLevel=.02,bedLevel=waterLevel-2.5){
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
    shader.uniforms.uWaterTime={value:0};(material.userData as {waterUniforms?:{value:number}}).waterUniforms=shader.uniforms.uWaterTime

    shader.vertexShader=shader.vertexShader
      .replace('#include <common>',`#include <common>
        varying vec3 vImantauWaterWorld;`)
      .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
        vImantauWaterWorld=(modelMatrix*vec4(transformed,1.0)).xyz;`)
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>',`#include <common>
        uniform float uWaterTime;
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
        vec3 viewDir=normalize(cameraPosition-vImantauWaterWorld);
        float fresnel=pow(1.0-max(dot(normalize(normal),viewDir),0.0),4.0);
        float waveA=sin(vImantauWaterWorld.x*0.075+uWaterTime*0.55)*0.012;
        float waveB=cos(vImantauWaterWorld.z*0.061-uWaterTime*0.38)*0.009;
        vec3 deepWater=vec3(0.055,0.20,0.23);
        vec3 skyReflection=vec3(0.48,0.62,0.65);
        diffuseColor.rgb=mix(deepWater,skyReflection,clamp(fresnel*0.72+0.08,0.0,0.8));
        diffuseColor.rgb+=vec3(waveA+waveB)*0.65;`)
  }
  material.customProgramCacheKey=()=> 'imantau-lake-shoreline-fresnel-v2'
  material.needsUpdate=true
}

/** Loads the Blender-built scene (tools/blender_build_scene.py). */
export async function loadLandscape(progress:(n:number)=>void,renderer:THREE.WebGLRenderer):Promise<Landscape> {
  const gltf=await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'scenes/IMANTAU-real.glb',e=>progress(e.total?e.loaded/e.total:0))
  const root=gltf.scene
  root.updateMatrixWorld(true)
  // Remove legacy standalone blue lake overlay meshes; the animated Lake_Water surface is authoritative.
  const obsoleteWaterNames=new Set(['Lake_Overlay','Water_Overlay','Lake_Blue_Patch','Water_Patch'])
  root.traverse(object=>{if(obsoleteWaterNames.has(object.name)){object.removeFromParent();if(object instanceof THREE.Mesh){object.geometry.dispose();for(const m of Array.isArray(object.material)?object.material:[object.material])m.dispose()}}})
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
          if(value instanceof THREE.Texture){value.anisotropy=maxAnisotropy;value.needsUpdate=true}
        }
      }
      if(material.name==='Lake_Water'&&material instanceof THREE.MeshStandardMaterial){
        object.castShadow=false;object.receiveShadow=false;object.renderOrder=1;object.position.y=.02
        material.envMapIntensity=1.6
        material.color.set('#b9d8d9')
        material.metalness=.28;material.roughness=.09
        material.polygonOffset=true;material.polygonOffsetFactor=-2;material.polygonOffsetUnits=-2
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
  // Keep the source morph animation intact. SceneEngine updates the shader clock each frame.
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
