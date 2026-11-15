import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, AudioLines, Expand, Glasses, HelpCircle, Layers, MapPin, MousePointer2, RotateCcw, Share2, X, Compass, Move, ScanLine } from 'lucide-react'
import { copy, photos, places, type Language } from './data/content'
import { SceneEngine, type MarkerPosition } from './viewer/SceneEngine'
import { InfoPanel } from './components/InfoPanel'
import { Modal } from './components/Modal'
import { ShareDialog } from './components/ShareDialog'
import './styles.css'
type Dialog = 'help'|'intro'|'share'|'vr'|null
function stored(key:string){try{return localStorage.getItem(key)}catch{return null}}
/** Wait for a promise but give up after `ms`; failures are ignored. */
function settle(p:Promise<unknown>,ms:number){return Promise.race([p.catch(()=>undefined),new Promise(r=>setTimeout(r,ms))])}
function save(key:string,value:string){try{localStorage.setItem(key,value)}catch{/* Optional persistence. */}}
/** Desktop info panel geometry (mirrors styles.css). */
function panelRect(){const w=innerWidth,h=innerHeight;if(w<=900)return null;const width=w>=1500?400:370;return{left:w-20-width,top:h<=760?102:106}}
/** Hide in-scene markers that would sit under the top bar, the info panel or the bottom controls. */
function occluded(m:MarkerPosition,panel:boolean){const h=innerHeight,top=innerWidth<=900?72:88;if(m.y<top+40||m.y>h-70)return true;const r=panel?panelRect():null;if(r&&m.x>r.left-24)return true;if(panel&&innerWidth<=900&&m.y>h*.5)return true;return false}
/** Thin leader line linking the selected in-scene marker to the open information panel (desktop). */
function Leader({markers,selected}:{markers:MarkerPosition[];selected:string|null}){
  const m=markers.find(item=>item.id===selected),r=panelRect()
  if(!m||!r||!m.visible||occluded(m,true))return null
  const x1=m.x,y1=m.y-21,x2=r.left,y2=r.top+92,mid=x1+(x2-x1)*.55
  return <svg className="leader" aria-hidden="true"><path d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}/><circle cx={x2} cy={y2} r={3}/></svg>
}
export default function App(){
  const [language,setLanguage]=useState<Language>(()=>stored('imantau-language')==='ru'?'ru':'kk')
  const t=copy[language]
  const app=useRef<HTMLDivElement>(null),host=useRef<HTMLDivElement>(null),engine=useRef<SceneEngine|null>(null)
  const [markers,setMarkers]=useState<MarkerPosition[]>([]),[selected,setSelected]=useState<string|null>(null)
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false),[progress,setProgress]=useState(0),[attempt,setAttempt]=useState(0)
  const [dialog,setDialog]=useState<Dialog>(()=>stored('imantau-museum-intro')?null:'intro')
  const [annotations,setAnnotations]=useState(true),[explorer,setExplorer]=useState(false),[vr,setVr]=useState(false),[vrBusy,setVrBusy]=useState(false)
  const [hovered,setHovered]=useState<string|null>(null)
  const [vrError,setVrError]=useState<'vrFallback'|'vrSecure'|'sensorStopped'|null>(null),[images,setImages]=useState<string[]>([])
  const selectedPlace=places.find(p=>p.id===selected)
  const closeDialog=()=>{if(dialog==='intro')save('imantau-museum-intro','1');if(dialog==='vr'&&vrBusy){engine.current?.stopVR();setVrBusy(false)}setDialog(null)}
  useEffect(()=>{
    if(!host.current)return
    setFailed(false);setReady(false);setProgress(0)
    try{engine.current=new SceneEngine(host.current,{progress:setProgress,ready:()=>setReady(true),error:()=>setFailed(true),markers:setMarkers,gallery:setImages,sensorStopped:()=>{setVr(false);setVrError('sensorStopped');setDialog('vr')}})}catch(error){console.error(error);setFailed(true)}
    return()=>{engine.current?.dispose();engine.current=null}
  },[attempt])
  useEffect(()=>{document.documentElement.lang=language;document.title=copy[language].pageTitle;save('imantau-language',language);engine.current?.setLanguage(language)},[language,ready])
  useEffect(()=>{engine.current?.setAnnotations(annotations)},[annotations,ready])
  useEffect(()=>{engine.current?.setPanel(!!selected)},[selected,ready])
  useEffect(()=>{const handle=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(vr)exitVR();setSelected(null);setExplorer(false)}};window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle)},[vr])
  useEffect(()=>{const handle=()=>{if(!document.fullscreenElement&&engine.current?.cardboard.active){engine.current.stopVR();setVr(false)}};document.addEventListener('fullscreenchange',handle);return()=>document.removeEventListener('fullscreenchange',handle)},[])
  function select(id:string){if(!ready)return;setSelected(id);setExplorer(false);engine.current?.focus(id)}
  function preset(id:'reset'|'aerial'|'shore'){engine.current?.preset(id)}
  async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await app.current?.requestFullscreen()}catch{/* Fullscreen is optional in embedded/iOS browsers. */}}
  async function startVR(){
    if(!window.isSecureContext){setVrError('vrSecure');return}
    setVrBusy(true);setVrError(null)
    // Fullscreen and the sensor permission must be requested inside the tap itself: browsers drop
    // the user gesture after the sensor wait, which is why fullscreen used to be refused.
    // The sensor permission prompt goes first: requestFullscreen consumes the tap's user activation.
    const sensor=engine.current?.startVR()
    const fs=document.fullscreenElement?Promise.resolve():(app.current?.requestFullscreen?.({navigationUI:'hide'})??Promise.reject()).catch(()=>{/* iPhone Safari: no element fullscreen */})
    // Some browsers never settle these promises (embedded views, desktop): never let them block VR.
    await settle(fs,1500)
    const orientation=screen.orientation as ScreenOrientation&{lock?:(o:string)=>Promise<void>}
    await settle(Promise.resolve().then(()=>orientation.lock?.('landscape')),1500)
    const ok=await sensor;setVrBusy(false)
    if(ok){setVr(true);setDialog(null);setSelected(null)}
    else{setVrError('vrFallback');try{screen.orientation.unlock?.()}catch{/* ignore */}if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{})}
  }
  function exitVR(){engine.current?.stopVR();setVr(false);try{screen.orientation.unlock?.()}catch{/* ignore */}if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{})}
  return <div className={`museum ${vr?'is-vr':''} ${selected?'has-panel':''}`} ref={app}>
    <div className="scene-host" ref={host}/>
    {!vr&&<><header className="topbar"><button className="brand" onClick={()=>{setSelected(null);preset('reset')}} aria-label="IMANTAU"><span className="brand-symbol"><Layers size={24}/></span><span>IMANTAU<small>{t.atlas}</small></span></button><nav aria-label={t.explore}><button className={selected==='lake'?'active':''} disabled={!ready} onClick={()=>select('lake')}>{t.overview}</button><button onClick={()=>{setExplorer(!explorer);setSelected(null)}} className={explorer?'active':''}>{t.explore}<ArrowUpRight size={15}/></button></nav><div className="top-actions"><div className="language" aria-label="Қазақша / Русский">{(['kk','ru'] as const).map(l=><button key={l} aria-pressed={l===language} onClick={()=>setLanguage(l)}>{l==='kk'?'ҚАЗ':'РУС'}</button>)}</div><button className="icon help-button" aria-label={t.help} title={t.help} onClick={()=>setDialog('help')}><HelpCircle size={19}/></button><button className="icon share-button" aria-label={t.share} title={t.share} onClick={()=>setDialog('share')}><Share2 size={18}/></button></div></header>
    <section className="scene-heading"><div className="eyebrow"><span className="live-dot"/>{t.region}</div><h1>Имантау<span>.</span></h1><p>{t.instruction}</p></section>
    <aside className={`explorer ${explorer?'open':''}`} aria-label={t.places}><div className="explorer-heading"><span className="eyebrow">{t.places}</span><button className="icon mobile-close" aria-label={t.close} onClick={()=>setExplorer(false)}><X size={17}/></button></div>{places.map(p=><button disabled={!ready} className={`location-row ${selected===p.id?'selected':''}`} key={p.id} onClick={()=>select(p.id)}><span className="location-number">{p.number}</span><span><strong>{p.title[language]}</strong><small>{p.category[language]}</small></span><ArrowUpRight size={16}/></button>)}<p className="explorer-note">{t.modelNote}</p></aside>
    <div className="annotations" aria-label={t.annotations}>{ready&&<Leader markers={markers} selected={selected}/>}{ready&&markers.map(marker=>{const p=places.find(item=>item.id===marker.id)!;const shown=marker.visible&&!occluded(marker,!!selected);return <button key={marker.id} className={`marker ${selected===marker.id?'selected':''} ${hovered===marker.id?'hovered':''} ${marker.x>innerWidth-200?'flip':''}`} style={{left:marker.x,top:marker.y,visibility:shown?'visible':'hidden'}} tabIndex={shown?0:-1} onClick={()=>{setHovered(null);select(marker.id)}} onMouseEnter={()=>setHovered(marker.id)} onMouseLeave={()=>setHovered(h=>h===marker.id?null:h)} onFocus={()=>setHovered(marker.id)} onBlur={()=>setHovered(h=>h===marker.id?null:h)} aria-label={p.title[language]} aria-pressed={selected===marker.id} aria-describedby={hovered===marker.id?'marker-card':undefined}><span className="pin">{p.number}</span><span className="marker-label">{p.title[language]}</span></button>})}
      {ready&&hovered&&hovered!==selected&&(()=>{const m=markers.find(x=>x.id===hovered),p=places.find(x=>x.id===hovered);if(!m||!p||!m.visible)return null;const photo=p.photos?.[0]?photos[p.photos[0]]:undefined;const left=Math.min(Math.max(m.x-150,12),innerWidth-312),above=m.y>innerHeight*.55;return <div id="marker-card" role="tooltip" className={`marker-card ${above?'above':'below'}`} style={{left,top:above?undefined:m.y+14,bottom:above?innerHeight-m.y+52:undefined}}>{photo&&<img src={import.meta.env.BASE_URL+'photos/'+photo.file} alt="" loading="lazy"/>}<div className="marker-card-body"><span className="eyebrow">{p.number} / {p.category[language]}</span><strong>{p.title[language]}</strong><p>{p.intro[language]}</p>{p.facts&&<dl>{p.facts.slice(0,2).map(f=><div key={f.label.ru}><dt>{f.label[language]}</dt><dd>{f.value[language]}</dd></div>)}</dl>}<em>{t.openDetails}</em></div></div>})()}
    </div>
    {selectedPlace&&<InfoPanel place={selectedPlace} language={language} t={t} images={images} onClose={()=>setSelected(null)} onSelect={select} onPreset={preset}/>}
    <div className="viewport-actions"><button className="icon mobile-explore" aria-label={t.explore} onClick={()=>setExplorer(!explorer)}><Layers size={19}/></button><button className="icon" aria-label={t.annotations} aria-pressed={annotations} title={t.annotations} onClick={()=>setAnnotations(!annotations)}><MapPin size={19}/></button><button className="icon" aria-label={t.full} title={t.full} onClick={()=>void fullscreen()}><Expand size={19}/></button><button className="icon mobile-help" aria-label={t.help} onClick={()=>setDialog('help')}><HelpCircle size={19}/></button></div>
    <footer className="bottom-bar"><div className="view-label"><Compass size={24}/><span>{t.model}<small>{t.placeCount}</small></span></div><div className="camera-presets" aria-label={t.view}><button disabled={!ready} onClick={()=>{setSelected(null);preset('reset')}}><RotateCcw size={15}/>{t.reset}</button><button disabled={!ready} onClick={()=>preset('aerial')}>{t.aerial}</button><button disabled={!ready} onClick={()=>preset('shore')}>{t.shore}</button></div><button className="vr-button" disabled={!ready} onClick={()=>{setVrError(null);setDialog('vr')}}><Glasses size={20}/>{t.vr}<ArrowUpRight size={15}/></button></footer>
    <div className="interaction-hint"><MousePointer2 size={13}/>{t.rotate}<span>·</span>{t.zoom}<span>·</span>{t.select}</div></>}
    {(!ready||failed)&&<div className="loading" role={failed?'alert':'status'}><span className="eyebrow">IMANTAU / 3D</span><h2>{failed?t.error:t.loading}</h2>{!failed&&<><p>{t.loadingNote}</p><div className="progress"><i style={{width:Math.max(3,progress*100)+'%'}}/></div><span>{Math.round(progress*100)}%</span></>}{failed&&<button onClick={()=>setAttempt(a=>a+1)}>{t.retry}</button>}</div>}
    {vr&&<><div className="vr-reticle"/><div className="vr-gaze-hint" data-vr-hint="visible">{t.vrGaze}</div><div className="vr-landscape">{t.vrLandscape}</div><div className="vr-controls"><button onClick={()=>engine.current?.cardboard.recenter()}><ScanLine size={18}/>{t.vrAlign}</button><button onClick={exitVR}><X size={18}/>{t.vrExit}</button></div></>}
    {(dialog==='intro'||dialog==='help')&&<Modal title={t.intro} t={t} onClose={closeDialog}><p>{t.introText}</p><div className="help-steps"><div><Move/><strong>{t.rotate}</strong><p>{t.mouse}</p></div><div><MousePointer2/><strong>{t.zoom}</strong><p>{t.touch}</p></div><div><MapPin/><strong>{t.select}</strong><p>{t.keyboard}</p></div><div><Glasses/><strong>{t.vr}</strong><p>{t.vrIntro}</p></div></div><button className="primary" onClick={closeDialog}>{dialog==='intro'?t.start:t.close}<ArrowUpRight size={18}/></button>{dialog==='intro'&&<button className="text-button" onClick={closeDialog}>{t.skip}</button>}</Modal>}
    {dialog==='share'&&<ShareDialog t={t} onClose={closeDialog}/>}
    {dialog==='vr'&&<Modal title={t.vrTitle} t={t} onClose={closeDialog}><div className="vr-illustration"><Glasses size={70}/><AudioLines size={30}/></div><p>{t.vrIntro}</p><p className="caption">{t.vrNote}</p>{vrError&&<p className="error" role="alert">{t[vrError]}</p>}<button className="primary" disabled={vrBusy||!ready} onClick={()=>void startVR()}>{vrBusy?t.vrWait:t.vrStart}<Glasses size={20}/></button></Modal>}
  </div>
}
