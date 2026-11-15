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
  g.addColorStop(0,'#2f6fc4');g.addColorStop(.32,'#5d97d8');g.addColorStop(.47,'#b9d3ea');g.addColorStop(.5,'#dfe8ec')
  // Below the horizon: pale aerial haze, so the diorama reads cleanly behind the museum UI.
  g.addColorStop(.53,'#f1f4f3');g.addColorStop(.7,'#e9eeec');g.addColorStop(1,'#e2e8e4')
  ctx.fillStyle=g;ctx.fillRect(0,0,w,h)
  // Deterministic pseudo-random so every load looks the same.
  let s=20261115;const rnd=()=>((s=(s*1664525+1013904223)>>>0)/4294967296)
  ctx.filter='blur(6px)'
  for(let c=0;c<46;c++){
    const cx=rnd()*w,cy=h*(.18+rnd()*.28),scale=.5+rnd()*1.1,flat=1-(cy/h-.18)*1.2
    for(let p=0;p<14;p++){
      const r=(22+rnd()*46)*scale*flat,x=cx+(rnd()-.5)*190*scale,y=cy+(rnd()-.6)*34*scale*flat
      const puff=ctx.createRadialGradient(x,y-r*.25,0,x,y,r)
      puff.addColorStop(0,'rgba(255,255,255,.95)');puff.addColorStop(.55,'rgba(246,248,252,.7)');puff.addColorStop(1,'rgba(225,233,244,0)')
      ctx.fillStyle=puff;ctx.beginPath();ctx.ellipse(x,y,r*1.5,r,0,0,Math.PI*2);ctx.fill()
    }
  }
  ctx.filter='none'
  const texture=new THREE.CanvasTexture(canvas)
  texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace
  return texture
}

export function lighting(scene:THREE.Scene, renderer:THREE.WebGLRenderer) {
  renderer.outputColorSpace=THREE.SRGBColorSpace
  renderer.toneMapping=THREE.AgXToneMapping
  renderer.toneMappingExposure=1.12
  renderer.shadowMap.enabled=true
  renderer.shadowMap.type=THREE.PCFSoftShadowMap
  const sky=paintSky()
  scene.background=sky;scene.backgroundIntensity=1.3;scene.backgroundBlurriness=.04
  const pmrem=new THREE.PMREMGenerator(renderer)
  const environment=pmrem.fromEquirectangular(sky)
  scene.environment=environment.texture; scene.environmentIntensity=0.9
  pmrem.dispose()
  scene.add(new THREE.HemisphereLight('#cfe1f5','#4d5c3e',0.5))
  const sun=new THREE.DirectionalLight('#fff1d6',2.4)
  sun.position.set(-14,24,6);sun.target.position.set(0,0,-7);scene.add(sun.target);sun.castShadow=true
  sun.shadow.mapSize.set(2048,2048)
  Object.assign(sun.shadow.camera,{left:-20,right:20,top:22,bottom:-22,near:1,far:70})
  sun.shadow.normalBias=0.035;sun.shadow.bias=-0.0001;sun.shadow.radius=3;sun.shadow.intensity=0.72
  scene.add(sun)
  return ()=>{environment.dispose();sky.dispose();sun.shadow.dispose()}
}
