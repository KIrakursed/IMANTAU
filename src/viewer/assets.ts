import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const lowPower=()=>matchMedia('(pointer:coarse)').matches||innerWidth<900
export interface Landscape { root:THREE.Group; mixer:THREE.AnimationMixer }

/** Deterministic multi-channel procedural detail texture (grass grain / rock structure / micro-shade). */
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
    const fine=105+hash(x,y,1)*50
    const rock=95+(Math.sin((x+y*size)*.015)*25)+hash(x,y,2)*40
    data[i]=fine
    data[i+1]=rock
    data[i+2]=(fine+rock)*.5
    data[i+3]=255
  }
  ctx.putImageData(image,0,0)
  const texture=new THREE.CanvasTexture(canvas)
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping
  texture.colorSpace=THREE.NoColorSpace
  texture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),lowPower()?4:12)
  texture.generateMipmaps=true
  texture.minFilter=THREE.LinearMipmapLinearFilter
  texture.magFilter=THREE.LinearFilter
  return texture
}

/** Add world-space grass/rock detail to the existing satellite albedo without replacing it. */
function improveTerrainMaterial(mesh:THREE.Mesh,renderer:THREE.WebGLRenderer,detail:THREE.Texture){
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material]
  for(const material of materials){
    if(!(material instanceof THREE.MeshStandardMaterial))continue
    const maxAnisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),lowPower()?4:12)
    if(material.map){
      material.map.anisotropy=maxAnisotropy
      material.map.minFilter=THREE.LinearMipmapLinearFilter
      material.map.magFilter=THREE.LinearFilter
      material.map.needsUpdate=true
    }
    material.bumpMap=detail
    material.bumpScale=lowPower()?.018:.028
    material.roughness=Math.max(material.roughness,.82)
    material.metalness=Math.min(material.metalness,.06)
    material.onBeforeCompile=(shader)=>{
      shader.uniforms.uTerrainDetail={value:detail}
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>',`#include <common>
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;`)
        .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
          vTerrainWorldPos=(modelMatrix*vec4(transformed,1.0)).xyz;
          vTerrainWorldNormal=normalize(mat3(transpose(inverse(modelMatrix)))*objectNormal);`)
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>',`#include <common>
          uniform sampler2D uTerrainDetail;
          varying vec3 vTerrainWorldPos;
          varying vec3 vTerrainWorldNormal;`)
        .replace('#include <map_fragment>',`#include <map_fragment>
          vec2 terrainUvA=vTerrainWorldPos.xz*0.08;
          vec2 terrainUvB=vTerrainWorldPos.xz*0.35;
          vec3 terrainDetailA=texture2D(uTerrainDetail,terrainUvA).rgb;
          vec3 terrainDetailB=texture2D(uTerrainDetail,terrainUvB).rgb;
          float terrainNoise=mix(terrainDetailA.r,terrainDetailB.g,0.5);
          float terrainSlope=1.0-clamp(normalize(vTerrainWorldNormal).y,0.0,1.0);
          float terrainRock=smoothstep(0.25,0.55,terrainSlope);
          vec3 rockTint=vec3(0.36,0.38,0.35)*(0.75+terrainNoise*0.5);
          diffuseColor.rgb=mix(
            diffuseColor.rgb*(0.82+terrainNoise*0.36),
            rockTint,
            terrainRock*0.42
          );`)
    }
    material.customProgramCacheKey=()=> 'imantau-terrain-detail-v2'
    material.needsUpdate=true
  }
}

/** Conservative camera clearance over a narrow ridge; ignores out-of-bounds samples. */
export function getSafeRidgeCameraY(
  getHeightAtXZ:(x:number,z:number)=>number|null,
  x:number,z:number,eyeHeight=2.5,radius=1.4,
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

/** Loads the Blender-built scene (tools/blender_build_scene.py). */
export async function loadLandscape(progress:(n:number)=>void,renderer:THREE.WebGLRenderer):Promise<Landscape> {
  const gltf=await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'scenes/IMANTAU-real.glb',e=>progress(e.total?e.loaded/e.total:0))
  const root=gltf.scene
  root.updateMatrixWorld(true)
  const detailTexture=createCrispDetailTexture(renderer)\n  const uses=new Map<string,THREE.Mesh[]>()
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return
    const material=object.material as THREE.MeshStandardMaterial
    object.castShadow=true;object.receiveShadow=true
    if(material.map)material.map.anisotropy=12
    if(material.name==='Lake_Water'){
      // Semi-transparent so the sandy shallows read turquoise, like the reference beach cove.
      object.castShadow=false;object.receiveShadow=false;object.renderOrder=1
      material.depthWrite=false;material.envMapIntensity=1.8
      // A touch of metalness strengthens the sky/cloud reflection the reference lake shows at oblique angles.
      material.metalness=.32;material.roughness=.035;material.opacity=.9
    }
    if(material.name==='Terrain'){object.castShadow=false;if(detailTexture)improveTerrainMaterial(object,renderer,detailTexture)}
    if(material.name==='Lake_Water'){
      material.polygonOffset=true;material.polygonOffsetFactor=1;material.polygonOffsetUnits=1
    }
    const key=object.geometry.uuid+'|'+material.uuid
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
