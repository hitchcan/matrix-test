import {lookup as dnsLookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
export function publicAddress(address){
  const ip=address.toLowerCase();if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
  if(isIP(ip)===6)return /^[23][0-9a-f]{0,3}:/.test(ip)&&!ip.includes('.')&&!ip.startsWith('2001:db8:')&&!/^2001:0*:/.test(ip)&&!ip.startsWith('2002:')&&!ip.startsWith('3fff:');
  return false;
}
export function publicUrl(value){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname||url.port&&!['80','443'].includes(url.port)||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicAddress(url.hostname.replace(/^\[|\]$/g,'')))throw Error('unsafe_public_url');return url;}
export async function downloadPublicImage(candidate,{signal,lookup=dnsLookup,transport}={}){
  const url=publicUrl(candidate.imageUrl),scoped=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]);scoped.throwIfAborted();
  const records=await new Promise((resolve,reject)=>{const abort=()=>reject(scoped.reason);scoped.addEventListener('abort',abort,{once:true});lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true,verbatim:true}).then(resolve,reject).finally(()=>scoped.removeEventListener('abort',abort));});scoped.throwIfAborted();
  if(!records.length||records.some(r=>!publicAddress(r.address)))throw Error('unsafe_public_address');
  const sorted=[...records].sort((a,b)=>a.family-b.family),request=transport||(url.protocol==='https:'?https.request:http.request);
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',signal:scoped,headers:{'User-Agent':'MatrixStudio/0.9 (public illustration download)'},lookup:(_host,options,callback)=>options?.all?callback(null,sorted):callback(null,sorted[0].address,sorted[0].family)},res=>{
      const mime=String(res.headers['content-type']||'').split(';')[0];
      if(res.statusCode!==200||!/^image\/(png|jpeg|webp)$/.test(mime)||Number(res.headers['content-length'])>10*1024*1024){res.resume();reject(Error('image_download_failed'));return;}
      const chunks=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>10*1024*1024){req.destroy(Error('image_too_large'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>{
        const bytes=Buffer.concat(chunks),valid=mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        if(!valid){reject(Error('invalid_image'));return;}resolve({bytes,mime});
      });
    });req.on('error',reject);req.end();
  });
}
