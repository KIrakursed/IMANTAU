import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Copy } from '../data/content'
export function Modal({title,onClose,t,children}:{title:string;onClose:()=>void;t:Copy;children:ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close()},[])
  return <dialog ref={dialog} className="modal" onCancel={e=>{e.preventDefault();onClose()}} onClick={e=>{if(e.target===dialog.current)onClose()}}><div className="modal-inner"><button className="icon close" aria-label={t.close} onClick={onClose}><X size={20}/></button><span className="eyebrow">IMANTAU / EXPLORER</span><h2>{title}</h2>{children}</div></dialog>
}
