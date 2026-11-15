import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import * as THREE from 'three'
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'work/qa')
await fs.mkdir(out,{recursive:true})
async function load(file){const src=await fs.readFile(path.join(root,file),'utf8'),compiled=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;const target=path.join(out,path.basename(file,'.ts')+'.mjs');await fs.writeFile(target,compiled);return import(pathToFileURL(target).href)}
const {publicUrl}=await load('src/utils/publicUrl.ts')
for(const value of ['','localhost','http://imantau-shalkar.kz','https://localhost','https://localhost.','https://192.168.1.2','https://127.1','https://[::1]','https://test.local','https://user:pass@site.kz','https://example.com'])assert.equal(publicUrl(value),null,value)
assert.equal(publicUrl('https://imantau-shalkar.kz/tour/'),'https://imantau-shalkar.kz/tour/')
const {copy,places}=await load('src/data/content.ts')
assert.deepEqual(Object.keys(copy.kk).sort(),Object.keys(copy.ru).sort())
for(const p of places){for(const lang of ['kk','ru'])for(const key of ['title','intro','detail','note','category'])assert.ok(p[key][lang]);p.related.forEach(id=>assert.ok(places.some(q=>q.id===id)))}
const {Cardboard}=await load('src/viewer/Cardboard.ts')
let sample=true
const listeners=new Map()
globalThis.window={isSecureContext:true,screen:{orientation:{angle:90}},addEventListener(type,fn){listeners.set(type,fn);if(sample)queueMicrotask(()=>fn({alpha:20,beta:90,gamma:0}))},removeEventListener(type){listeners.delete(type)},setTimeout,clearTimeout}
globalThis.screen=globalThis.window.screen
globalThis.DeviceOrientationEvent=class {static async requestPermission(){return 'granted'}}
const camera=new THREE.PerspectiveCamera(42,2,.04,250);camera.position.set(23,22,28);camera.lookAt(0,0,-6);camera.updateMatrixWorld()
const original=camera.position.clone(),originalQuaternion=camera.quaternion.clone()
const board=new Cardboard(camera)
const spawn=new THREE.Vector3(130,4,20),look=new THREE.Vector3(42,2,-3)
assert.equal(await board.start(spawn,look),true)
assert.ok(camera.position.equals(spawn),'VR starts at the requested ground position')
// Mobile VR is intentionally ONE full-screen view (project decision), not a split stereo pair.
const views=[];let renders=0
board.render({setScissorTest(){},setScissor(){},setViewport(...v){views.push(v)},render(){renders++}},new THREE.Scene(),1200,600)
assert.deepEqual(views,[[0,0,1200,600]]);assert.equal(renders,1)
board.recenter();board.stop();assert.equal(board.active,false);assert.equal(listeners.size,0);assert.ok(camera.position.equals(original));assert.ok(camera.quaternion.equals(originalQuaternion));assert.equal(camera.fov,42)
// A refused permission is not final when real samples still arrive (some Android browsers).
globalThis.DeviceOrientationEvent.requestPermission=async()=> 'denied';assert.equal(await board.start(spawn,look),true);board.stop()
globalThis.window.isSecureContext=false;assert.equal(await board.start(spawn,look),false)
delete globalThis.DeviceOrientationEvent;globalThis.window.isSecureContext=true;assert.equal(await board.start(spawn,look),false)
sample=false
const {Heightfield}=await load('src/viewer/heightfield.ts')
const plane=new THREE.PlaneGeometry(100,100,50,50);plane.rotateX(-Math.PI/2)
const pp=plane.getAttribute('position');for(let i=0;i<pp.count;i++)pp.setY(i,pp.getX(i)*.1)
const field=new Heightfield(new THREE.Mesh(plane))
assert.ok(Math.abs(field.at(10,3)-1)<1e-4,'bilinear height');assert.equal(field.at(80,0),null,'outside')
const gazeHit=field.raycast(new THREE.Vector3(0,20,0),new THREE.Vector3(1,-1,0).normalize(),200)
assert.ok(gazeHit&&Math.abs(gazeHit.x-20/1.1)<.05&&Math.abs(gazeHit.y-gazeHit.x*.1)<.01,'gaze ray hits the ground: '+JSON.stringify(gazeHit))
assert.equal(field.raycast(new THREE.Vector3(0,20,0),new THREE.Vector3(1,.2,0).normalize(),200),null,'looking up never hits')
console.log('PASS: URL rules, KK/RU key parity, linked POIs, synthetic sensor permission branches, single full-screen VR viewport, ground spawn, recenter and camera cleanup, VR gaze heightfield ray.')
