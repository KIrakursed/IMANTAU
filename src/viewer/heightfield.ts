import * as THREE from 'three'

/**
 * Regular-grid height lookup built from the terrain mesh, so VR gaze can march a ray cheaply
 * (a triangle raycast over ~0.5 M faces every frame would stall phones).
 */
export class Heightfield {
  private heights:Float32Array
  private cols:number
  private rows:number
  private minX:number;private minZ:number;private dx:number;private dz:number
  constructor(mesh:THREE.Mesh){
    mesh.updateMatrixWorld(true)
    const pos=mesh.geometry.getAttribute('position'),v=new THREE.Vector3()
    const xs=new Set<number>(),zs=new Set<number>(),pts:number[]=[]
    for(let i=0;i<pos.count;i++){v.fromBufferAttribute(pos,i).applyMatrix4(mesh.matrixWorld);pts.push(v.x,v.y,v.z);xs.add(Math.round(v.x*100));zs.add(Math.round(v.z*100))}
    this.cols=xs.size;this.rows=zs.size
    const bx=[...xs],bz=[...zs]
    this.minX=Math.min(...bx)/100;this.minZ=Math.min(...bz)/100
    this.dx=(Math.max(...bx)/100-this.minX)/(this.cols-1);this.dz=(Math.max(...bz)/100-this.minZ)/(this.rows-1)
    this.heights=new Float32Array(this.cols*this.rows).fill(-1e9)
    for(let i=0;i<pts.length;i+=3){const c=Math.round((pts[i]-this.minX)/this.dx),r=Math.round((pts[i+2]-this.minZ)/this.dz);this.heights[r*this.cols+c]=pts[i+1]}
  }
  /** Bilinear height at world x/z, or null outside the surveyed area. */
  at(x:number,z:number):number|null{
    const fx=(x-this.minX)/this.dx,fz=(z-this.minZ)/this.dz
    if(fx<0||fz<0||fx>=this.cols-1||fz>=this.rows-1)return null
    const c=Math.floor(fx),r=Math.floor(fz),tx=fx-c,tz=fz-r,h=this.heights,i=r*this.cols+c
    return (h[i]*(1-tx)+h[i+1]*tx)*(1-tz)+(h[i+this.cols]*(1-tx)+h[i+this.cols+1]*tx)*tz
  }
  /** First ground hit along a ray (step-marched, then refined). */
  raycast(origin:THREE.Vector3,dir:THREE.Vector3,far=260,step=.6):THREE.Vector3|null{
    const p=origin.clone(),prev=origin.clone()
    for(let t=step;t<=far;t+=step){
      prev.copy(p);p.copy(origin).addScaledVector(dir,t)
      const h=this.at(p.x,p.z);if(h===null)return null
      if(p.y<=h){
        let a=t-step,b=t
        for(let k=0;k<6;k++){const m=(a+b)/2,q=origin.clone().addScaledVector(dir,m),hm=this.at(q.x,q.z)??q.y;if(q.y<=hm)b=m;else a=m}
        const hit=origin.clone().addScaledVector(dir,b);hit.y=this.at(hit.x,hit.z)??hit.y;return hit
      }
    }
    return null
  }
}
