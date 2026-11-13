import {chromium} from 'playwright';
import {readFileSync,statSync} from 'node:fs';

// Only the explicitly selected local media is served to this isolated browser.
export async function sourceMedia(assets,pathFor,signal) {
  if(assets.length>8)throw Error('source_media_limit');
  const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});
  const abort=()=>void browser.close().catch(()=>{});
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    const page=await browser.newPage();const results=[];
    for(const asset of assets) {
      signal.throwIfAborted();const path=pathFor(asset.id);
      if(statSync(path).size>150*1024*1024)throw Error('source_media_size');
      await page.unrouteAll();
      await page.route('**/*',route=>route.request().url()==='http://127.0.0.1/source'
        ?route.fulfill({body:readFileSync(path),contentType:asset.mime,headers:{'Access-Control-Allow-Origin':'*'}}):route.abort());
      await page.setContent('<body></body>');
      const previews=await page.evaluate(async video=>{
        const media=document.createElement(video?'video':'img');media.crossOrigin='anonymous';
        if(video){media.muted=true;media.preload='auto';}
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('decode_timeout')),20000);
          media[video?'onloadeddata':'onload']=()=>{clearTimeout(timer);resolve();};media.onerror=()=>{clearTimeout(timer);reject(Error('decode_failed'));};
          media.src='http://127.0.0.1/source';});
        const width=video?media.videoWidth:media.naturalWidth,height=video?media.videoHeight:media.naturalHeight;
        const canvas=document.createElement('canvas'),scale=Math.min(1,768/Math.max(width,height));
        canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
        const frames=[];
        for(const fraction of (video?[0,.5,.9]:[0])) {
          if(video&&fraction){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('seek_timeout')),10000);
            media.onseeked=()=>{clearTimeout(timer);resolve();};media.currentTime=media.duration*fraction;});}
          canvas.getContext('2d').drawImage(media,0,0,canvas.width,canvas.height);
          frames.push({at:video?Math.round(media.duration*fraction*10)/10:null,url:canvas.toDataURL('image/jpeg',.8)});
        }
        return frames;
      },asset.mime.startsWith('video/'));
      results.push({...asset,previews});
    }
    return results;
  } finally {signal.removeEventListener('abort',abort);await browser.close();}
}
