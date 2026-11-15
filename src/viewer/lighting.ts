import * as THREE from 'three'

/**
 * Outdoor summer daylight modelled on the project reference photo (deep blue sky with cumulus
 * clouds, warm high sun). The source USDZ ships only a uniform #121212 DomeLight, so it offers no
 * usable sky. We paint an equirectangular sky (gradient + soft procedural clouds) and use it both
 * as the background and, through PMREM, as the environment — the lake then reflects the clouds.
 */
function paintSky(){
  const w=2048,h=1024,canvas=document.createElement('canvas');canvas.width=w;canvas.height=h
  const ctx=canvas.getContext('2d')!
  const g=ctx.createLinearGradient(0,0,0,h)
  g.addColorStop(0,'#1f5bb8');g.addColorStop(.3,'#3a7dd2');g.addColorStop(.44,'#4a8bdb');g.addColorStop(.482,'#78ade8');g.addColorStop(.497,'#b3d0ef');g.addColorStop(.5,'#c6dbef')
  // Below the horizon: pale aerial haze, so the diorama reads cleanly behind the museum UI.
  g.addColorStop(.53,'#cddff0');g.addColorStop(.7,'#dbe7f1');g.addColorStop(1,'#e4ecf2')
  ctx.fillStyle=g;ctx.fillRect(0,0,w,h)
  // Deterministic pseudo-random so every load looks the same.
  let s=20261115;const rnd=()=>((s=(s*1664525+1013904223)>>>0)/4294967296)
  ctx.filter='blur(6px)'
  for(let c=0;c<46;c++){
    const cx=rnd()*w,cy=h*(.3+rnd()*.17),scale=.5+rnd()*1.1,flat=1-(cy/h-.25)*1.6
    for(let p=0;p<14;p++){
      const r=(22+rnd()*46)*scale*flat,x=cx+(rnd()-.5)*190*scale,y=cy+(rnd()-.6)*34*scale*flat
      const puff=ctx.createRadialGradient(x,y-r*.25,0,x,y,r)
      puff.addColorStop(0,'rgba(255,255,255,.95)');puff.addColorStop(.55,'rgba(246,248,252,.7)');puff.addColorStop(1,'rgba(225,233,244,0)')
      ctx.fillStyle=puff
      // draw wrapped copies so the equirect seam (and its reflection in the lake) stays invisible
      for(const ox of [-w,0,w]){ctx.save();ctx.translate(ox,0);ctx.beginPath();ctx.ellipse(x,y,r*1.5,r,0,0,Math.PI*2);ctx.fill();ctx.restore()}
    }
  }
  ctx.filter='none'
  const texture=new THREE.CanvasTexture(canvas)
  texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace
  return texture
}

export function lighting(scene:THREE.Scene, renderer:THREE.WebGLRenderer) {
  renderer.outputColorSpace=THREE.SRGBColorSpace
  renderer.toneMapping=THREE.NeutralToneMapping
  renderer.toneMappingExposure=1.0
  renderer.shadowMap.enabled=true
  renderer.shadowMap.type=THREE.PCFSoftShadowMap
  const sky=paintSky()
  // Aerial perspective: distant terrain edges dissolve into the horizon haze, as in the photo.
  scene.fog=new THREE.Fog('#c6dbef',560,1500)
  // The surveyed area is ~22 x 23 km; beyond it a plain in the region's average colour runs into
  // the haze so the model's edge is not seen as a cliff against the sky.
  const plain=new THREE.Mesh(new THREE.CircleGeometry(4000,64),new THREE.MeshLambertMaterial({color:'#7d9474'}))
  plain.rotation.x=-Math.PI/2;plain.position.y=-.6;plain.name='Regional_plain';scene.add(plain)
  scene.background=sky;scene.backgroundIntensity=1.0;scene.backgroundBlurriness=.04
  const pmrem=new THREE.PMREMGenerator(renderer)
  const environment=pmrem.fromEquirectangular(sky)
  scene.environment=environment.texture; scene.environmentIntensity=0.9
  pmrem.dispose()
  scene.add(new THREE.HemisphereLight('#cfe1f5','#4d5c3e',0.5))
  const sun=new THREE.DirectionalLight('#fff1d6',2.4)
  sun.position.set(-320,480,220);sun.target.position.set(0,0,-20);scene.add(sun.target);sun.castShadow=true
  sun.shadow.mapSize.set(4096,4096)
  Object.assign(sun.shadow.camera,{left:-300,right:300,top:320,bottom:-320,near:20,far:1600})
  sun.shadow.normalBias=0.6;sun.shadow.bias=-0.0004;sun.shadow.radius=2;sun.shadow.intensity=0.72
  scene.add(sun)
  return ()=>{environment.dispose();sky.dispose();sun.shadow.dispose()}
}
