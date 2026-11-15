import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
export async function loadLandscape(progress:(n:number)=>void) {
  const gltf=await new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'scenes/IMANTAU-enhanced.glb',e=>progress(e.total?e.loaded/e.total:0))
  const root=gltf.scene
  root.updateMatrixWorld(true)
  const batches=new Map<string,{geometry:THREE.BufferGeometry;material:THREE.Material;meshes:THREE.Mesh[]}>()
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return
    object.castShadow=true;object.receiveShadow=true
    const material=object.material as THREE.MeshStandardMaterial
    if(material.map)material.map.anisotropy=4
    if(material instanceof THREE.MeshPhysicalMaterial&&material.transmission>0){
      // Water colour/absorption are authored in Blender (tools/blender_enhance.py). A shadow-casting
      // water box would darken the basin it should reveal, so the surface casts no shadow; the
      // sky environment is boosted a little so clouds reflect like in the reference photo.
      object.castShadow=false
      material.envMapIntensity=1.5
      material.specularIntensity=1
    }
    if(/Vegetation|Bark/i.test(material.name)){
      if(/Vegetation/i.test(material.name)){material.transparent=false;material.alphaTest=.42;material.depthWrite=true}
      const key=object.geometry.uuid+material.uuid
      const batch=batches.get(key)??{geometry:object.geometry,material,meshes:[] as THREE.Mesh[]}
      batch.meshes.push(object);batches.set(key,batch)
    }
  })
  // Shared tree geometry is drawn once per material, retaining every source world transform.
  for(const {geometry,material,meshes} of batches.values()){
    const instance=new THREE.InstancedMesh(geometry,material,meshes.length)
    instance.name='Forest_instances';instance.castShadow=true;instance.receiveShadow=true
    meshes.forEach((mesh,i)=>{instance.setMatrixAt(i,mesh.matrixWorld);mesh.removeFromParent()})
    instance.instanceMatrix.needsUpdate=true;instance.computeBoundingSphere();root.add(instance)
  }
  return root
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
