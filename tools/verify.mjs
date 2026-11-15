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
globalThis.window={isSecureContext:true,addEventListener(type,fn){listeners.set(type,fn);if(sample)queueMicrotask(()=>fn({alpha:20,beta:90,gamma:0}))},removeEventListener(type){listeners.delete(type)},setTimeout,clearTimeout}
globalThis.screen={orientation:{angle:90}}
globalThis.DeviceOrientationEvent=class {static async requestPermission(){return 'granted'}}
const camera=new THREE.PerspectiveCamera(42,2,.04,250);camera.position.set(23,22,28);camera.lookAt(0,0,-6);camera.updateMatrixWorld()
const original=camera.position.clone(),originalQuaternion=camera.quaternion.clone()
const board=new Cardboard(camera)
assert.equal(await board.start(),true)
const views=[],eyes=[]
board.render({setScissorTest(){},setScissor(){},setViewport(...v){views.push(v)},render(scene,eye){eyes.push(eye.matrixWorld.clone())}},new THREE.Scene(),1200,600)
assert.deepEqual(views,[[0,0,600,600],[600,0,600,600]])
assert.ok(Math.abs(board.stereo.cameraL.projectionMatrix.elements[0]-board.stereo.cameraL.projectionMatrix.elements[5])<1e-6,'Each eye must have aspect 1 for a 1200x600 viewport')
assert.ok(eyes[0].elements.some((v,i)=>Math.abs(v-eyes[1].elements[i])>1e-6),'Stereo eye transforms differ')
board.recenter();board.stop();assert.equal(board.active,false);assert.equal(listeners.size,0);assert.ok(camera.position.equals(original));assert.ok(camera.quaternion.equals(originalQuaternion));assert.equal(camera.fov,42)
globalThis.DeviceOrientationEvent.requestPermission=async()=> 'denied';assert.equal(await board.start(),false)
globalThis.window.isSecureContext=false;assert.equal(await board.start(),false)
delete globalThis.DeviceOrientationEvent;globalThis.window.isSecureContext=true;assert.equal(await board.start(),false)
sample=false
console.log('PASS: URL rules, KK/RU key parity, linked POIs, synthetic sensor permission branches, stereo projection/viewport/eye separation, recenter and camera cleanup.')
