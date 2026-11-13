import {chromium} from 'playwright';
export async function inspectGeneratedVideo(bytes,signal) {
  signal.throwIfAborted();
  const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome'});
  const abort=()=>{void browser.close().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    const page=await browser.newPage({viewport:{width:1080,height:1440},deviceScaleFactor:1});
    await page.route('**/*',route=>route.request().url()==='http://127.0.0.1/clip.mp4'
      ?route.fulfill({contentType:'video/mp4',body:bytes}):route.abort());
    await page.setContent('<style>body{margin:0;background:#111}video{display:block;width:1080px;height:1440px;object-fit:contain}</style><video muted preload="auto"></video>');
    const metadata=await page.evaluate(()=>new Promise((resolve,reject)=>{
      const v=document.querySelector('video');
      const timer=setTimeout(()=>reject(Error('video_decode_timeout')),20000);
      v.onerror=()=>{clearTimeout(timer);reject(Error('video_decode_failed'));};
      v.onloadeddata=()=>{clearTimeout(timer);resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight});};
      v.src='http://127.0.0.1/clip.mp4';
    }));
    if(!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>600||!metadata.width||!metadata.height)throw Error('invalid_video_metadata');
    return {...metadata,cover:await page.screenshot({type:'png',timeout:10000})};
  } finally {signal.removeEventListener('abort',abort);await browser.close();}
}
