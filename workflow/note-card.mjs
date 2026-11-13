import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';

// Use a separate, offline page; rendering never opens a publishing profile.
export async function renderNoteCard({path,mime,title,signal}) {
  if(!['image/jpeg','image/png','image/webp'].includes(mime))throw Error('unsupported_card_image');
  const bytes=await readFile(path,{signal});
  if(bytes.length>32*1024*1024)throw Error('card_image_too_large');
  signal.throwIfAborted();
  const browser=await chromium.launch({headless:true,channel:process.env.MATRIX_BROWSER_CHANNEL||'chrome',timeout:20000});
  const abort=()=>{void browser.close().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    const page=await browser.newPage({viewport:{width:1080,height:1440},deviceScaleFactor:1});
    await page.route(/^https?:/,route=>route.abort());
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;width:1080px;height:1440px;background:#f7f4ed;color:#192d28;display:grid;grid-template-rows:924px 1fr}
      img{display:block;width:100%;height:100%;object-fit:cover}
      section{margin:0 70px;border-top:9px solid #344e41;display:flex;align-items:center;overflow:hidden}
      h1{margin:0;font:700 78px/1.25 "Microsoft YaHei",sans-serif;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
    </style><img alt=""><section><h1></h1></section>`);
    await page.evaluate(async({src,title})=>{
      document.querySelector('h1').textContent=title;
      const img=document.querySelector('img');img.src=src;await img.decode();
      if(!img.naturalWidth||!img.naturalHeight)throw Error('invalid_image');
      await document.fonts.ready;
    },{src:`data:${mime};base64,${bytes.toString('base64')}`,title});
    return await page.screenshot({type:'png',timeout:15000});
  } finally {signal.removeEventListener('abort',abort);await browser.close();}
}
