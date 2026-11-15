import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export type ViewerState = { progress: number; loaded: boolean; error: boolean }
export type Controls = { active: boolean; vr: boolean; move: { x: number; y: number }; speed: number }

export class ImantauRenderer {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(65, 1, 0.05, 100000)
  stereo = new THREE.StereoCamera()
  state: ViewerState = { progress: 0, loaded: false, error: false }
  controls: Controls = { active: false, vr: false, move: { x: 0, y: 0 }, speed: 1 }
  private raf = 0
  private root: THREE.Object3D | null = null
  private onState: (s: ViewerState) => void
  private yaw = 0
  private pitch = 0
  private dragging = false
  private lastX = 0
  private lastY = 0
  private keys = new Set<string>()
  private sensorQ = new THREE.Quaternion()
  private sensorBase: THREE.Quaternion | null = null
  private cameraBase = new THREE.Quaternion()
  private orientationHandler = (event: DeviceOrientationEvent) => this.readOrientation(event)
  private pointerDown = (e: PointerEvent) => { if (!this.controls.active || this.controls.vr) return; this.dragging = true; this.lastX=e.clientX; this.lastY=e.clientY; this.renderer.domElement.setPointerCapture(e.pointerId) }
  private pointerMove = (e: PointerEvent) => { if(!this.dragging) return; this.yaw -= (e.clientX-this.lastX)*0.004; this.pitch -= (e.clientY-this.lastY)*0.004; this.pitch=THREE.MathUtils.clamp(this.pitch,-1.45,1.45); this.lastX=e.clientX; this.lastY=e.clientY; this.updateCameraRotation() }
  private pointerUp = () => { this.dragging=false }
  private keyDown = (e: KeyboardEvent) => { if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault(); this.keys.add(e.key.toLowerCase()) }
  private keyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase())
  private wheel = (e: WheelEvent) => { if(!this.controls.active || this.controls.vr) return; e.preventDefault(); this.camera.fov=THREE.MathUtils.clamp(this.camera.fov+e.deltaY*0.025,35,90); this.camera.updateProjectionMatrix() }
  private previous = performance.now()

  constructor(private host: HTMLElement, onState: (s: ViewerState) => void) {
    this.onState=onState
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.matchMedia('(pointer: coarse)').matches ? 1.35 : 1.65))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.setClearColor(0x6d9b9c,1)
    this.renderer.domElement.className='scene-canvas'
    this.renderer.domElement.setAttribute('aria-label','Interactive 3D view of the supplied Imantau scene')
    host.appendChild(this.renderer.domElement)
    this.scene.add(new THREE.HemisphereLight(0xe4f3ed,0x283b34,2.0))
    const sun=new THREE.DirectionalLight(0xfff4dc,2.0); sun.position.set(40,90,25); this.scene.add(sun)
    this.camera.position.set(0,2,10); this.camera.lookAt(0,0,0)
    this.bind()
    this.resize()
    new GLTFLoader().load(import.meta.env.BASE_URL + 'scenes/IMANTAU.glb', gltf=>{
      this.root=gltf.scene
      this.scene.add(this.root)
      const box=new THREE.Box3().setFromObject(this.root)
      const size=box.getSize(new THREE.Vector3()); const center=box.getCenter(new THREE.Vector3())
      const span=Math.max(size.x,size.y,size.z,1); this.root.userData.walkSpeed=span*0.008
      // Start near the scene edge so visitors see the authored environment before walking through it.
      this.camera.position.set(center.x,center.y+Math.max(size.y*0.18,2.2),center.z+size.z*0.36)
      this.camera.near=Math.max(span/10000,0.02); this.camera.far=span*30; this.camera.updateProjectionMatrix()
      this.camera.lookAt(center); this.yaw=0; this.pitch=0
      this.cameraBase.copy(this.camera.quaternion)
      this.state={progress:100,loaded:true,error:false}; this.onState(this.state)
    }, xhr=>{
      const progress=xhr.total ? Math.round(xhr.loaded/xhr.total*100) : Math.min(95,Math.round(xhr.loaded/24873700*100))
      this.state={...this.state,progress}; this.onState(this.state)
    },()=>{ this.state={...this.state,error:true}; this.onState(this.state) })
    this.raf=requestAnimationFrame(this.frame)
  }
  private bind() {
    const c=this.renderer.domElement
    c.addEventListener('pointerdown',this.pointerDown); c.addEventListener('pointermove',this.pointerMove); c.addEventListener('pointerup',this.pointerUp); c.addEventListener('pointercancel',this.pointerUp); c.addEventListener('wheel',this.wheel,{passive:false})
    window.addEventListener('keydown',this.keyDown); window.addEventListener('keyup',this.keyUp); window.addEventListener('resize',this.resize)
  }
  setControls(controls: Controls) { this.controls=controls; this.keys.clear(); if(!controls.vr) this.sensorBase=null }
  reset() { if(this.root){ const box=new THREE.Box3().setFromObject(this.root); const size=box.getSize(new THREE.Vector3()); const center=box.getCenter(new THREE.Vector3()); const span=Math.max(size.x,size.y,size.z,1); this.root.userData.walkSpeed=span*0.008; this.camera.position.set(center.x,center.y+Math.max(size.y*.18,2.2),center.z+size.z*.36); this.camera.lookAt(center); this.cameraBase.copy(this.camera.quaternion); this.yaw=0;this.pitch=0;this.sensorBase=null } }
  async enableOrientation(): Promise<'ok'|'denied'|'unsupported'> {
    const doe=DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?:()=>Promise<'granted'|'denied'> }
    if(!('DeviceOrientationEvent' in window)) return 'unsupported'
    try { if(typeof doe.requestPermission==='function' && await doe.requestPermission()!=='granted') return 'denied'; window.addEventListener('deviceorientation',this.orientationHandler,true); return 'ok' } catch { return 'denied' }
  }
  disableOrientation() { window.removeEventListener('deviceorientation',this.orientationHandler,true); this.sensorBase=null }
  private readOrientation(e: DeviceOrientationEvent) {
    if(e.alpha===null||e.beta===null||e.gamma===null) return
    const zee=new THREE.Vector3(0,0,1), euler=new THREE.Euler(), q0=new THREE.Quaternion(), q1=new THREE.Quaternion(-Math.sqrt(.5),0,0,Math.sqrt(.5))
    const orient=(screen.orientation?.angle ?? (window as Window & {orientation?:number}).orientation ?? 0)*Math.PI/180
    euler.set(THREE.MathUtils.degToRad(e.beta),THREE.MathUtils.degToRad(e.alpha),-THREE.MathUtils.degToRad(e.gamma),'YXZ')
    this.sensorQ.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee,-orient))
    if(!this.sensorBase) this.sensorBase=this.sensorQ.clone().invert()
  }
  private updateCameraRotation() {
    const euler=new THREE.Euler(this.pitch,this.yaw,0,'YXZ')
    this.camera.quaternion.copy(this.cameraBase).multiply(new THREE.Quaternion().setFromEuler(euler))
  }
  private resize=()=>{const w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight);this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.matchMedia('(pointer: coarse)').matches ? 1.35 : 1.65));this.renderer.setSize(w,h,false);this.camera.aspect=(this.controls.vr?w/2:w)/h;this.camera.updateProjectionMatrix()}
  private frame=(now:number)=>{
    this.raf=requestAnimationFrame(this.frame)
    const dt=Math.min(.05,(now-this.previous)/1000);this.previous=now
    if(this.controls.active&&this.root){
      if(this.controls.vr&&this.sensorBase){ const target=this.cameraBase.clone().multiply(this.sensorBase).multiply(this.sensorQ); this.camera.quaternion.slerp(target,1-Math.exp(-dt*24)) }
      else this.updateCameraRotation()
      const forward=new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion); forward.y=0; forward.normalize(); const right=new THREE.Vector3(1,0,0).applyQuaternion(this.camera.quaternion);right.y=0;right.normalize()
      const x=(this.keys.has('d')||this.keys.has('arrowright')?1:0)-(this.keys.has('a')||this.keys.has('arrowleft')?1:0)+this.controls.move.x
      const y=(this.keys.has('w')||this.keys.has('arrowup')?1:0)-(this.keys.has('s')||this.keys.has('arrowdown')?1:0)-this.controls.move.y
      if(x||y){const speed=Math.max(0.12,(this.root as THREE.Object3D).userData.walkSpeed??3)*this.controls.speed*dt;this.camera.position.addScaledVector(right,x*speed);this.camera.position.addScaledVector(forward,y*speed);if(this.keys.has('shift'))this.camera.position.addScaledVector(forward,y*speed*1.5)}
      if(this.keys.has(' ')) this.camera.position.y+=dt*3
    }
    const w=this.host.clientWidth,h=this.host.clientHeight
    if(this.controls.vr){ this.stereo.aspect=(w/2)/h; this.stereo.eyeSep=0.064; this.camera.aspect=(w/2)/h; this.camera.updateProjectionMatrix(); this.stereo.update(this.camera); this.renderer.setScissorTest(true); this.renderer.setViewport(0,0,Math.floor(w/2),h); this.renderer.setScissor(0,0,Math.floor(w/2),h); this.renderer.render(this.scene,this.stereo.cameraL); this.renderer.setViewport(Math.floor(w/2),0,w-Math.floor(w/2),h); this.renderer.setScissor(Math.floor(w/2),0,w-Math.floor(w/2),h); this.renderer.render(this.scene,this.stereo.cameraR); this.renderer.setScissorTest(false) }
    else { this.camera.aspect=w/h; this.camera.updateProjectionMatrix(); this.renderer.render(this.scene,this.camera) }
  }
  dispose() { cancelAnimationFrame(this.raf);this.disableOrientation();window.removeEventListener('keydown',this.keyDown);window.removeEventListener('keyup',this.keyUp);window.removeEventListener('resize',this.resize);const c=this.renderer.domElement;c.removeEventListener('pointerdown',this.pointerDown);c.removeEventListener('pointermove',this.pointerMove);c.removeEventListener('pointerup',this.pointerUp);c.removeEventListener('pointercancel',this.pointerUp);c.removeEventListener('wheel',this.wheel);this.renderer.dispose();const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();this.root?.traverse(obj=>{const mesh=obj as THREE.Mesh;if(mesh.geometry)geometries.add(mesh.geometry);for(const material of (Array.isArray(mesh.material)?mesh.material:mesh.material?[mesh.material]:[])){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value)}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());this.host.removeChild(c) }
}





