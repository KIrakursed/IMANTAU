import { useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, X, Image } from 'lucide-react'
import { dataCredits, photos, places, sources, type Copy, type Language, type Place } from '../data/content'

type PresetName='reset'|'aerial'|'shore'
const PRESETS:PresetName[]=['reset','aerial','shore']

export function InfoPanel({place,language,t,images,onClose,onSelect,onPreset}:{place:Place;language:Language;t:Copy;images:string[];onClose:()=>void;onSelect:(id:string)=>void;onPreset:(id:PresetName)=>void}){
  const index=places.indexOf(place)
  const shots=(place.photos??[]).map(id=>photos[id]).filter(Boolean)
  const [open,setOpen]=useState<number|null>(null)
  const big=open===null?null:shots[open]
  return <aside className="info-panel" aria-label={place.title[language]} key={place.id}>
    <div className="panel-scroll">
      <div className="panel-top"><span className="eyebrow">{place.number} / {place.category[language]}</span><button className="icon" aria-label={t.close} onClick={onClose}><X size={19}/></button></div>
      <h2>{place.title[language]}</h2>
      <p className="lead">{place.intro[language]}</p>
      {shots.length>0&&<figure className="hero-photo"><button onClick={()=>setOpen(0)} aria-label={shots[0].caption[language]}><img src={import.meta.env.BASE_URL+'photos/'+shots[0].file} alt={shots[0].caption[language]} loading="lazy"/></button><figcaption>{shots[0].caption[language]} · <a href={shots[0].page} target="_blank" rel="noreferrer">{shots[0].author}</a>, <a href={shots[0].licenseUrl} target="_blank" rel="noreferrer">{shots[0].license}</a></figcaption></figure>}
      {place.facts&&<><h3>{t.keyFacts}</h3><dl className="facts">{place.facts.map(f=><div key={f.label.ru}><dt>{f.label[language]}</dt><dd>{f.value[language]}</dd></div>)}</dl></>}
      <h3>{t.details}</h3><p>{place.detail[language]}</p>
      <div className="note"><span className="note-dot"/>{place.note[language]}</div>
      {shots.length>1&&<><h3>{t.photos}</h3><div className="photo-grid">{shots.slice(1).map((p,i)=><button key={p.file} onClick={()=>setOpen(i+1)} title={p.caption[language]}><img src={import.meta.env.BASE_URL+'photos/'+p.file} alt={p.caption[language]} loading="lazy"/></button>)}</div></>}
      {place.id==='lake'&&images.length>0&&<><h3>{t.gallery}</h3><div className="gallery">{images.map((src,i)=><button key={i} onClick={()=>onPreset(PRESETS[i])} title={t[PRESETS[i]]}><img src={src} alt={t[PRESETS[i]]}/><span>{t[PRESETS[i]]}</span></button>)}</div><p className="caption"><Image size={14}/>{t.galleryNote}</p></>}
      <h3>{t.related}</h3>
      <div className="related">{place.related.map(id=>{const item=places.find(p=>p.id===id)!;return <button key={id} onClick={()=>onSelect(id)}><span>{item.number} <strong>{item.title[language]}</strong></span><ArrowUpRight size={17}/></button>})}</div>
      <details className="sources"><summary>{t.sources}</summary>{sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.name}<ArrowUpRight size={13}/></a>)}<p><strong>{t.dataCredits}.</strong> {t.modelNote}</p>{dataCredits.map(c=><a key={c.url} href={c.url} target="_blank" rel="noreferrer">{c.name}<ArrowUpRight size={13}/></a>)}</details>
    </div>
    <div className="panel-footer"><button aria-label={t.previous} onClick={()=>onSelect(places[(index+places.length-1)%places.length].id)}><ArrowLeft size={17}/>{t.previous}</button><span>{index+1} / {String(places.length).padStart(2,'0')}</span><button aria-label={t.next} onClick={()=>onSelect(places[(index+1)%places.length].id)}>{t.next}<ArrowRight size={17}/></button></div>
    {big&&<div className="lightbox" role="dialog" aria-label={big.caption[language]} onClick={()=>setOpen(null)}><img src={import.meta.env.BASE_URL+'photos/'+big.file} alt={big.caption[language]}/><p>{big.caption[language]} · {big.author}, {big.date} · <a href={big.page} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>Wikimedia Commons</a> · <a href={big.licenseUrl} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>{big.license}</a></p><button className="icon" aria-label={t.close}><X size={20}/></button></div>}
  </aside>
}
