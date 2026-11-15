import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { places, type Language } from '../data/content'
import { lighting } from './lighting'
import { loadLandscape, disposeScene } from './assets'
import { Cardboard } from './Cardboard'
import { Heightfield } from './heightfield'
/** Camera poses (three.js Y-up). 'reset' mirrors the reference photo: high, from the south shore,
 *  looking across the lake to the mountain. */
const POSES={
  // Real geography (1 unit = 40 m, +x east, -z north). From the north end of the lake looking
  // south-south-west across the water to the Imantau massif — the reference-photo composition.
  reset:{position:new THREE.Vector3(-70,140,-350),target:new THREE.Vector3(14,62,40)},
  aerial:{position:new THREE.Vector3(-6,720,-36),target:new THREE.Vector3(-6,0,-34)},
  // From the shore by Imantau village (SE) towards Kazachy Island and the mountain.
  shore:{position:new THREE.Vector3(176,16,8),target:new THREE.Vector3(30,6,52)},
}
export interface MarkerPosition {id:string;x:number;y:number;visible:boolean}
export interface ViewerCallbacks {progress:(n:number)=>void;ready:()=>void;error:()=>void;markers:(m:MarkerPosition[])=>void;sensorStopped:()=>void;gallery:(images:string[])=>void;gaze?:(progress:number)=>void}
export class SceneEngine {
  readonly scene=new THREE.Scene()
  readonly camera=new THREE.PerspectiveCamera(42,1,.3,6000)
  readonly renderer:THREE.WebGLRenderer
  readonly controls:OrbitControls
  readonly cardboard:Cardboard
  private cleanupLighting:()=>void
  private root?:THREE.Group
  private mixer?:THREE.AnimationMixer
  private ground?:Heightfield
  // VR gaze locomotion: look at the ground for GAZE_MS and the viewer glides there.
  private gazePoint=new THREE.Vector3(1e9,0,0);private gazeDwell=0;private gazeShown=0
  private walk?:{start:number;from:THREE.Vector3;to:THREE.Vector3}
  private observer:ResizeObserver
  private dead=false
  private width=1;private height=1
  private targets=new Map<string,THREE.Vector3>()
  private labels=new Map<string,THREE.Sprite>()
  private ring:THREE.Mesh
  private raycaster=new THREE.Raycaster()
  private projection=new THREE.Vector3()
  private transition?:{start:number;from:THREE.Vector3;to:THREE.Vector3;targetFrom:THREE.Vector3;targetTo:THREE.Vector3}
  private lastMarker=0
  private frame=0
  private language:Language='kk'
  private annotations=true
  private panel=false
  private samples:number[]=[]
  private previousFrame=performance.now()
  private statsTime=0
  constructor(private host:HTMLElement,private cb:ViewerCallbacks){
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'})
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.appendChild(this.renderer.domElement)
    this.renderer.domElement.tabIndex=0
    this.controls=new OrbitControls(this.camera,this.renderer.domElement)
    this.controls.enableDamping=true;this.controls.dampingFactor=.07;this.controls.minDistance=4;this.controls.maxDistance=1100;this.controls.maxPolarAngle=Math.PI*.48
    this.controls.addEventListener('start',this.cancelTransition)
    this.camera.position.copy(POSES.reset.position);this.controls.target.copy(POSES.reset.target)
    this.controls.update()
    this.cardboard=new Cardboard(this.camera)
    this.cleanupLighting=lighting(this.scene,this.renderer)
    this.ring=new THREE.Mesh(new THREE.RingGeometry(.94,1,64),new THREE.MeshBasicMaterial({color:'#f8f0bd',side:THREE.DoubleSide,depthTest:false,transparent:true,opacity:.7}))
    this.ring.rotation.x=-Math.PI/2;this.ring.visible=false;this.ring.renderOrder=10;this.scene.add(this.ring)
    this.observer=new ResizeObserver(this.resize);this.observer.observe(host);this.resize()
    host.addEventListener('dblclick',this.doubleClick)
    this.renderer.domElement.addEventListener('keydown',this.key)
    this.renderer.domElement.addEventListener('webglcontextlost',this.contextLost)
    this.animate()
    void this.load()
  }
  private contextLost=(e:Event)=>{e.preventDefault();this.cb.error()}
  private async load(){
    try{
      const {root,mixer}=await loadLandscape(this.cb.progress)
      if(this.dead){disposeScene(root);return}
      this.root=root;this.mixer=mixer;
      const terrain=root.getObjectByName('Terrain');const terrainMesh=terrain instanceof THREE.Mesh?terrain:terrain?.children.find(c=>c instanceof THREE.Mesh) as THREE.Mesh|undefined
      if(terrainMesh)this.ground=new Heightfield(terrainMesh)
      this.scene.add(root);root.updateMatrixWorld(true)
      for(const p of places){
        const node=root.getObjectByName(p.node)??root.getObjectByName(p.node.replaceAll('_',' '))
        if(!node)throw new Error('Missing authored POI node: '+p.node)
        const box=new THREE.Box3().setFromObject(node),target=new THREE.Vector3()
        // Authored POI empties (Blender) carry their exact position; meshes use their bounds.
        if(box.isEmpty()){node.getWorldPosition(target);this.targets.set(p.id,target);continue}
        if(p.offset){target.set(THREE.MathUtils.lerp(box.min.x,box.max.x,p.offset[0]),box.max.y+5,THREE.MathUtils.lerp(box.min.z,box.max.z,p.offset[2]));this.raycaster.set(target,new THREE.Vector3(0,-1,0));const hit=this.raycaster.intersectObject(node,true)[0];if(!hit)throw new Error('POI surface not found: '+p.id);target.copy(hit.point)}
        else {box.getCenter(target);target.y=box.max.y}
        target.y+=.25;this.targets.set(p.id,target)
      }
      this.setLanguage(this.language);this.captureGallery();this.renderer.shadowMap.autoUpdate=false;this.preset('reset');this.cb.ready()
    }catch(error){console.error('Landscape loading failed',error);if(!this.dead)this.cb.error()}
  }
  private captureGallery(){
    const old=this.camera.position.clone(),target=this.controls.target.clone()
    const images:string[]=[]
    this.renderer.setSize(900,560,false);this.camera.aspect=900/560;this.camera.updateProjectionMatrix()
    for(const pose of [POSES.reset,POSES.aerial,POSES.shore]){
      this.camera.position.copy(pose.position);this.camera.lookAt(pose.target);this.camera.updateMatrixWorld();this.renderer.setViewport(0,0,900,560);this.renderer.render(this.scene,this.camera)
      const canvas=document.createElement('canvas');canvas.width=900;canvas.height=560;canvas.getContext('2d')!.drawImage(this.renderer.domElement,0,0,900,560);images.push(canvas.toDataURL('image/webp',.82))
    }
    this.camera.position.copy(old);this.controls.target.copy(target);this.resize();this.controls.update();this.cb.gallery(images)
  }
  private resize=()=>{this.width=this.host.clientWidth;this.height=this.host.clientHeight;if(!this.width||!this.height)return;this.renderer.setSize(this.width,this.height);this.camera.aspect=this.width/this.height;this.camera.clearViewOffset();if(this.panel&&!this.cardboard.active){if(this.width<=900)this.camera.setViewOffset(this.width,this.height,0,this.height*.19,this.width,this.height);else this.camera.setViewOffset(this.width,this.height,(this.width>=1500?420:390)/2,0,this.width,this.height)}this.camera.updateProjectionMatrix()}
  setPanel(value:boolean){this.panel=value;this.resize()}
  private cancelTransition=()=>{this.transition=undefined}
  private move(target:THREE.Vector3,position:THREE.Vector3){this.transition={start:performance.now(),from:this.camera.position.clone(),to:position,targetFrom:this.controls.target.clone(),targetTo:target}}
  focus(id:string){const p=places.find(p=>p.id===id),target=this.targets.get(id);if(!p||!target)return;const d=p.distance;this.move(target.clone(),target.clone().add(new THREE.Vector3(d*.8,d*.75,d)));this.ring.position.copy(target);this.ring.visible=true;this.ring.scale.setScalar(p.distance*.28)}
  preset(name:'reset'|'aerial'|'shore'){
    const target=POSES[name].target.clone(),position=POSES[name].position.clone()
    // Portrait screens: back off until the lake (~150 units wide) fits the horizontal field of view.
    const aspect=this.width/this.height
    if(aspect<1&&name!=='shore'){
      const halfH=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))*aspect
      const distance=THREE.MathUtils.clamp(105/halfH,350,480)
      const direction=name==='aerial'?new THREE.Vector3(0,1,.08):new THREE.Vector3(.06,.58,.81)
      target.set(0,0,-30) // aim at the lake itself; the wide-screen pose looks past it to the mountain
      position.copy(target).addScaledVector(direction.normalize(),distance)
    }
    this.move(target,position);this.ring.visible=false
  }
  private doubleClick=(e:MouseEvent)=>{
    if(!this.root||this.cardboard.active)return
    const rect=this.host.getBoundingClientRect()
    this.raycaster.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1),this.camera)
    const hit=this.raycaster.intersectObject(this.root,true)[0]
    if(hit)this.move(hit.point,hit.point.clone().add(this.camera.position.clone().sub(this.controls.target).normalize().multiplyScalar(60)))
  }
  private key=(e:KeyboardEvent)=>{
    if(this.cardboard.active)return
    if(e.key==='Home'){e.preventDefault();this.preset('reset');return}
    const offset=this.camera.position.clone().sub(this.controls.target),sphere=new THREE.Spherical().setFromVector3(offset)
    if(e.key==='ArrowLeft')sphere.theta-=.12;else if(e.key==='ArrowRight')sphere.theta+=.12;else if(e.key==='ArrowUp')sphere.phi-=.1;else if(e.key==='ArrowDown')sphere.phi+=.1;else if(e.key==='+'||e.key==='=')sphere.radius*=.85;else if(e.key==='-')sphere.radius*=1.15;else return
    e.preventDefault();sphere.phi=THREE.MathUtils.clamp(sphere.phi,.05,Math.PI*.48);sphere.radius=THREE.MathUtils.clamp(sphere.radius,4,1100);this.move(this.controls.target.clone(),new THREE.Vector3().setFromSpherical(sphere).add(this.controls.target))
  }
  setLanguage(language:Language){
    this.language=language
    this.labels.forEach(label=>{label.removeFromParent();label.material.map?.dispose();label.material.dispose()});this.labels.clear()
    for(const p of places){const position=this.targets.get(p.id);if(!position)continue
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96
      const ctx=canvas.getContext('2d')!;ctx.fillStyle='#163d32';ctx.fillRect(0,0,512,96);ctx.fillStyle='#fff9e8';ctx.font='28px sans-serif';ctx.textAlign='center';ctx.fillText(p.number+'  '+p.title[language],256,59)
      const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace
      const label=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false}));label.position.copy(position).add(new THREE.Vector3(0,5,0));label.scale.set(24,4.5,1);label.visible=false;this.scene.add(label);this.labels.set(p.id,label)
    }
    this.renderer.domElement.setAttribute('aria-label',language==='kk'?'Имантау интерактивті 3D көрінісі':'Интерактивная 3D-сцена Имантау')
  }
  setAnnotations(value:boolean){this.annotations=value}
  async startVR(){
    this.transition=undefined

    // The VR spawn is anchored to the authored south-east shore camera pose.
    // Resolve its Y coordinate from the loaded terrain instead of hard-coding
    // a position that may put the viewer inside the lake or below the ground.
    const shore=POSES.shore.position
    const terrainHeight=this.ground?.at(shore.x,shore.z)??null
    const spawn=new THREE.Vector3(
      shore.x,
      terrainHeight===null?shore.y:terrainHeight+4.8,
      shore.z,
    )
    const target=POSES.shore.target.clone()
    target.y=spawn.y

    const ok=await this.cardboard.start(spawn,target)
    this.controls.enabled=!ok
    if(ok){
      this.camera.clearViewOffset()
      this.resize()
    }
    return ok
  }
  stopVR(){this.walk=undefined;this.gazeDwell=0;this.setGaze(0);this.cardboard.stop();this.controls.enabled=true;this.resize()}
  private animate=()=>{
    if(this.dead)return
    this.frame=requestAnimationFrame(this.animate)
    if(document.hidden)return
    const time=performance.now()
    const delta=time-this.previousFrame;this.previousFrame=time;if(delta<250){this.samples.push(delta);if(this.samples.length>90)this.samples.shift()}
    this.mixer?.update(Math.min(delta,100)/1000)
    if(this.transition){const t=Math.min((time-this.transition.start)/1100,1),ease=t*t*(3-2*t);this.camera.position.lerpVectors(this.transition.from,this.transition.to,ease);this.controls.target.lerpVectors(this.transition.targetFrom,this.transition.targetTo,ease);if(t===1)this.transition=undefined}
    this.labels.forEach(label=>label.visible=this.cardboard.active&&this.annotations)
    if(this.cardboard.active){
      if(this.cardboard.stale){this.stopVR();this.cb.sensorStopped()}
      else{this.updateGaze(delta,time);this.cardboard.render(this.renderer,this.scene,this.width,this.height)}
    }else{
      this.controls.update();this.renderer.setScissorTest(false);this.renderer.setViewport(0,0,this.width,this.height);this.renderer.render(this.scene,this.camera)
      if(import.meta.env.DEV&&time-this.statsTime>1000){this.statsTime=time;this.renderer.domElement.dataset.diagnostics=JSON.stringify({...this.stats,fps:Math.round(1000/(this.samples.reduce((a,b)=>a+b,0)/this.samples.length))})}
      if(time-this.lastMarker>50){this.lastMarker=time;this.cb.markers(places.map(p=>{const target=this.targets.get(p.id);if(!target)return{id:p.id,x:0,y:0,visible:false};this.projection.copy(target).project(this.camera);return{id:p.id,x:(this.projection.x*.5+.5)*this.width,y:(-.5*this.projection.y+.5)*this.height,visible:this.annotations&&this.projection.z>-1&&this.projection.z<1&&Math.abs(this.projection.x)<.94&&Math.abs(this.projection.y)<.9}}))}
    }
  }
  private setGaze(p:number){if(Math.abs(p-this.gazeShown)>.04||(p===0&&this.gazeShown!==0)){this.gazeShown=p;this.cb.gaze?.(p)}}
  private updateGaze(delta:number,time:number){
    const GAZE_MS=1600,EYE=2.4
    if(this.walk){
      const t=Math.min((time-this.walk.start)/1400,1),e=t*t*(3-2*t)
      this.camera.position.lerpVectors(this.walk.from,this.walk.to,e)
      if(t===1)this.walk=undefined
      return
    }
    if(!this.ground)return
    const dir=new THREE.Vector3(0,0,-1).applyQuaternion(this.camera.quaternion)
    // Only a downward look at dry land (above the lake surface) counts as "go there".
    const hit=dir.y<-.1?this.ground.raycast(this.camera.position,dir):null
    if(!hit||hit.y<.15||hit.distanceTo(this.camera.position)<3){this.gazeDwell=0;this.gazePoint.set(1e9,0,0);this.setGaze(0);return}
    if(hit.distanceTo(this.gazePoint)>4){this.gazePoint.copy(hit);this.gazeDwell=0}else this.gazeDwell+=Math.min(delta,100)
    const p=Math.min(this.gazeDwell/GAZE_MS,1);this.setGaze(p)
    if(p>=1){this.walk={start:time,from:this.camera.position.clone(),to:hit.clone().add(new THREE.Vector3(0,EYE,0))};this.gazeDwell=0;this.gazePoint.set(1e9,0,0);this.setGaze(0)}
  }
  get stats(){return{...this.renderer.info.memory,drawCalls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,poiCount:this.targets.size,groundReady:!!this.ground,groundAtLake:this.ground?.at(-12.6,-66)??null}}
  dispose(){this.dead=true;cancelAnimationFrame(this.frame);this.cardboard.stop();this.observer.disconnect();this.controls.dispose();this.host.removeEventListener('dblclick',this.doubleClick);this.renderer.domElement.removeEventListener('keydown',this.key);this.renderer.domElement.removeEventListener('webglcontextlost',this.contextLost);disposeScene(this.scene);this.cleanupLighting();this.renderer.dispose();this.renderer.domElement.remove()}
}
