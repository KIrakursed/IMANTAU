/** Syntax validation only: deployment ownership and DNS reachability require a real deployment. */
export function publicUrl(value:string):string|null {
  try{
    const u=new URL(value),host=u.hostname.toLowerCase().replace(/\.$/,'')
    if(u.protocol!=='https:'||u.username||u.password||u.port||!host.includes('.')||/^[\d.]+$/.test(host)||host.includes(':')||/(^|\.)(localhost|local|test|invalid|example|internal|lan)$/.test(host)||/(^|\.)example\.(com|org|net)$/.test(host))return null
    return u.href
  }catch{return null}
}
