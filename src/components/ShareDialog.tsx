import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy as CopyIcon, Download, Share2 } from 'lucide-react'
import type { Copy } from '../data/content'
import { Modal } from './Modal'
import { publicUrl } from '../utils/publicUrl'
export function ShareDialog({t,onClose}:{t:Copy;onClose:()=>void}){
  const [value,setValue]=useState(import.meta.env.VITE_PUBLIC_SITE_URL||publicUrl(location.href)||'')
  const [qr,setQr]=useState(''),[svg,setSvg]=useState(''),[status,setStatus]=useState<'copied'|'shareFailed'|null>(null)
  const url=publicUrl(value)
  useEffect(()=>{let cancelled=false;setQr('');setSvg('');if(url)void Promise.all([QRCode.toDataURL(url,{width:420,margin:3,color:{dark:'#163d32',light:'#fffdf7'}}),QRCode.toString(url,{type:'svg',margin:3})]).then(([png,vector])=>{if(!cancelled){setQr(png);setSvg(vector)}}).catch(()=>{if(!cancelled)setStatus('shareFailed')});return()=>{cancelled=true}},[url])
  async function copy(){try{await navigator.clipboard.writeText(url!);setStatus('copied')}catch{setStatus('shareFailed')}}
  async function share(){try{await navigator.share({title:'IMANTAU',url:url!})}catch(e){if((e as Error).name!=='AbortError')setStatus('shareFailed')}}
  function download(){const blob=new Blob([svg],{type:'image/svg+xml'}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download='imantau-qr.svg';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
  return <Modal title={t.share} onClose={onClose} t={t}><p>{t.urlHint}</p><label className="field">{t.url}<input type="url" value={value} onChange={e=>{setValue(e.target.value);setStatus(null)}} placeholder="https://…" autoComplete="url"/></label>{value&&!url&&<p className="error" role="alert">{t.invalidUrl}</p>}{qr&&<img className="qr" src={qr} alt="QR"/>}<div className="share-actions"><button disabled={!url} onClick={()=>void copy()}><CopyIcon size={17}/>{t.copy}</button><button disabled={!svg} onClick={download}><Download size={17}/>{t.download}</button>{typeof navigator.share==='function'&&<button disabled={!url} onClick={()=>void share()}><Share2 size={17}/>{t.share}</button>}</div>{status&&<p role="status">{t[status]}</p>}</Modal>
}
