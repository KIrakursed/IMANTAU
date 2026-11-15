import * as THREE from 'three'
type PermissionEvent = typeof DeviceOrientationEvent & {requestPermission?:()=>Promise<string>}
export class Cardboard {
  active=false
  readonly stereo=new THREE.StereoCamera()
  private raw=new THREE.Quaternion()
  private correction=new THREE.Quaternion()
  private euler=new THREE.Euler()
  private screenRotation=new THREE.Quaternion()
  private base=new THREE.Quaternion(-Math.sqrt(.5),0,0,Math.sqrt(.5))
  private axis=new THREE.Vector3(0,0,1)
  private latest=0
  private savedPosition=new THREE.Vector3()
  private savedQuaternion=new THREE.Quaternion()
  private savedFov=42
  private pending:((value:boolean)=>void)|null=null
  constructor(private camera:THREE.PerspectiveCamera) { this.stereo.aspect=.5; this.stereo.eyeSep=.064 }
  private onOrientation=(event:DeviceOrientationEvent)=>{
    if(event.alpha===null||event.beta===null||event.gamma===null)return
    const rad=THREE.MathUtils.degToRad
    this.euler.set(rad(event.beta),rad(event.alpha),-rad(event.gamma),'YXZ')
    const angle=screen.orientation?.angle??Number((window as Window & {orientation?:number}).orientation??0)
    this.raw.setFromEuler(this.euler).multiply(this.base).multiply(this.screenRotation.setFromAxisAngle(this.axis,-rad(angle)))
    this.latest=performance.now();this.pending?.(true);this.pending=null
  }
  async start():Promise<boolean> {
    if(!window.isSecureContext||typeof DeviceOrientationEvent==='undefined')return false
    try {
      const api=DeviceOrientationEvent as PermissionEvent
      if(api.requestPermission && await api.requestPermission()!=='granted')return false
      window.addEventListener('deviceorientation',this.onOrientation)
      const sampled=await new Promise<boolean>(resolve=>{
        const timer=window.setTimeout(()=>{this.pending=null;resolve(false)},4000)
        this.pending=value=>{clearTimeout(timer);resolve(value)}
      })
      if(!sampled){this.stop();return false}
      this.savedPosition.copy(this.camera.position);this.savedQuaternion.copy(this.camera.quaternion);this.savedFov=this.camera.fov
      this.camera.position.set(132,3.2,22);this.camera.lookAt(42,2,-3);this.camera.fov=80
      this.recenter();this.active=true;return true
    }catch{this.stop();return false}
  }
  recenter(){
    // Preserve a level forward heading; cancel the current sensor quaternion once.
    const direction=new THREE.Vector3(42,2,-3).sub(this.camera.position);direction.y=0
    const level=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(),direction,new THREE.Vector3(0,1,0)))
    this.correction.copy(level).multiply(this.raw.clone().invert())
  }
  render(renderer:THREE.WebGLRenderer,scene:THREE.Scene,width:number,height:number){
    this.camera.quaternion.copy(this.correction).multiply(this.raw)
    this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld(true)
    this.stereo.update(this.camera)
    renderer.setScissorTest(true)
    renderer.setScissor(0,0,width/2,height);renderer.setViewport(0,0,width/2,height);renderer.render(scene,this.stereo.cameraL)
    renderer.setScissor(width/2,0,width/2,height);renderer.setViewport(width/2,0,width/2,height);renderer.render(scene,this.stereo.cameraR)
    renderer.setScissorTest(false)
  }
  get stale(){return this.active&&performance.now()-this.latest>6000}
  stop(){
    window.removeEventListener('deviceorientation',this.onOrientation)
    this.pending?.(false);this.pending=null
    if(this.active){this.camera.position.copy(this.savedPosition);this.camera.quaternion.copy(this.savedQuaternion);this.camera.fov=this.savedFov;this.camera.updateProjectionMatrix()}
    this.active=false
  }
}
