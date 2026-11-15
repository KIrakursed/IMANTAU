import fs from 'node:fs'
const UA='IMANTAU-museum-build/1.0 (educational site generator)'
const titles=['Штиль зеркало.jpg','Отражение 1.jpg','Имантау осень.jpg','Золотая осень Имантау.jpg','08 2016 Имантау (20).jpg','Имантау.jpg','Будто пальмы.jpg','Закат на Имантау.jpg','Кристальный Имантау.jpg','Imantau.jpg']
const u=new URL('https://commons.wikimedia.org/w/api.php')
Object.entries({action:'query',titles:titles.map(t=>'File:'+t).join('|'),prop:'imageinfo',iiprop:'url|extmetadata|size',iiurlwidth:'1280',iiextmetadatafilter:'LicenseShortName|LicenseUrl|Artist|DateTimeOriginal',format:'json'}).forEach(([k,v])=>u.searchParams.set(k,v))
const d=await (await fetch(u,{headers:{'User-Agent':UA}})).json()
const pages=Object.values(d.query.pages).filter(p=>p.imageinfo)
pages.sort((a,b)=>titles.indexOf(a.title.slice(5))-titles.indexOf(b.title.slice(5)))
const out=[]
for(const [i,p] of pages.entries()){
  const ii=p.imageinfo[0],m=ii.extmetadata,file=`imantau-${String(i+1).padStart(2,'0')}.jpg`
  const buf=Buffer.from(await (await fetch(ii.thumburl,{headers:{'User-Agent':UA}})).arrayBuffer())
  fs.writeFileSync('public/photos/'+file,buf)
  out.push({file,title:p.title.slice(5),page:ii.descriptionurl,author:(m.Artist?.value||'').replace(/<[^>]+>/g,'').trim(),license:m.LicenseShortName?.value,licenseUrl:m.LicenseUrl?.value||'',date:(m.DateTimeOriginal?.value||'').replace(/<[^>]+>/g,'').slice(0,10),w:ii.thumbwidth,h:ii.thumbheight,bytes:buf.length})
  await new Promise(r=>setTimeout(r,300))
}
fs.writeFileSync('work/geo/raw/photos.json',JSON.stringify(out,null,1))
for(const o of out)console.log(o.file,'|',o.title,'|',o.author,'|',o.license,'|',o.date,'|',o.w+'x'+o.h,'|',o.bytes)
