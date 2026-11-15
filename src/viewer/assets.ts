import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const lowPower=()=>matchMedia('(pointer:coarse)').matches||innerWidth<900
export interface Landscape { root:THREE.Group; mixer:THREE.AnimationMixer }

/** Loads the Blender-built scene (tools/blender_build_scene.py). */
export async function loadLandscape(progress:(n:number)=>void):Promise<Landscape> {
  const gltf=await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'scenes/IMANTAU-real.glb',e=>progress(e.total?e.loaded/e.total:0))
  const root=gltf.scene
  root.updateMatrixWorld(true)
  const uses=new Map<string,THREE.Mesh[]>()
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
    if(material.name==='Terrain')object.castShadow=false
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
