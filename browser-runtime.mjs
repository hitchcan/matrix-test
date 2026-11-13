import {bilibiliArticleEditorUrl,bilibiliArticleField,bilibiliArticleSettings,bilibiliArticleAi,bilibiliArticlePublishButton,bilibiliArticleSuccessVisible,bilibiliArticleReceipt,pasteBilibiliArticleImages} from './bilibili-article.mjs';
import { observeRecovery } from './workflow/recovery-page.mjs';
import {observeVisualRecovery} from './workflow/visual-recovery.mjs';
import {operationPacer} from './browser-pace.mjs';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {cleanHtml} from './rich-content.mjs';
import {publicationOf} from './publication.mjs';
import {douyinVisibility} from './douyin-visibility.mjs';
import {waitForRich} from './rich-check.mjs';
import {pasteZhihuImages} from './zhihu-images.mjs';
import {zhihuPanel,zhihuFinalButton,isZhihuEditor,waitZhihuReceipt} from './zhihu-article.mjs';
import {applyZhihuAi} from './zhihu-ai.mjs';
import {creatorIdentityReady,watchCreatorIdentity} from './creator-identity.mjs';
import {xhsMode,xhsUpload,xhsField,xhsPublishButton,xhsEditorUrl,xhsReceipt,xhsSuccessVisible} from './xhs-publisher.mjs';
import {applyDeclarationAi} from './zhihu-ai.mjs';
import {douyinField,douyinUpload,douyinAi,douyinPublishButton,douyinEditorUrl,douyinReceipt,douyinSuccessVisible} from './douyin-publisher.mjs';
import {zhihuWithoutAi} from './zhihu-no-ai.mjs';
import {applyXhsAi} from './xhs-disclosure.mjs';
import {readBilibiliIdentity} from './bilibili-identity.mjs';
import {bilibiliDiskFiles,bilibiliUpload,bilibiliField,bilibiliAi,bilibiliEditorUrl,bilibiliPublishButton,bilibiliReceipt,bilibiliSuccessVisible} from './bilibili-publisher.mjs';
import {uploadBilibiliCover,requireBilibiliCover} from './bilibili-cover.mjs';
import {douyinVerificationPage} from './douyin-verification.mjs';

const contentHtml = (content,platform) => content.type==='article' ? ((content.versions?.[platform]?.body ? content.versions[platform].bodyHtml : content.bodyHtml)||'') : '';
async function assertRich(field,html) {
  const result=await waitForRich(field,html);
  if(!result.valid)throw Object.assign(browserError(`平台正文检查未通过：${result.textMatch?'缺少格式 '+result.missing.join(','):`文字长度 ${result.actualChars}/${result.expectedChars}`}${result.ignoredUiChars?`（已排除图片空注释提示 ${result.ignoredUiChars} 字）`:''}。已暂停提交。`),
    result.missing.some(mark=>['img','image_upload'].includes(mark))?{code:'image_upload_failed'}:{});
}

export const browserError = (message, state = 'needs_manual') => Object.assign(new Error(message), { state, status: 409 });
function protect(bytes, decrypt = false) {
  if (process.platform !== 'win32') throw browserError('当前加密会话恢复仅支持Windows');
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script], {input:bytes.toString('base64'),windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:16*1024*1024}).trim(),'base64');
}
export const routes = {
  zhihu: { home: 'https://www.zhihu.com/creator', identity: '.AppHeader-userInfo a[href*="zhihu.com/people/"], a.ProfileEntry-link[href*="/people/"]', identityPattern: /https:\/\/(?:www\.)?zhihu\.com\/people\/([^/?#]+)/, origins: ['www.zhihu.com', 'zhuanlan.zhihu.com'] },
  bilibili: { home: 'https://member.bilibili.com/', identity: '.bcc-global-header a[href*="space.bilibili.com/"], .bcc-header a[href*="space.bilibili.com/"], a.header-entry-avatar[href*="space.bilibili.com/"]', identityPattern: /https:\/\/space\.bilibili\.com\/(\d+)/, origins: ['member.bilibili.com'] },
  xhs: { home: 'https://creator.xiaohongshu.com/new/home', identity: '.user-info a[href*="xiaohongshu.com/user/profile/"]', identityPattern: /https:\/\/www\.xiaohongshu\.com\/user\/profile\/([^/?#]+)/, origins: ['creator.xiaohongshu.com'] },
  douyin:{home:'https://creator.douyin.com/creator-micro/home',identity:'[data-account-self] a[href*="douyin.com/user/"], [class*="user-info"] a[href*="douyin.com/user/"], [class*="accountInfo"] a[href*="douyin.com/user/"]',identityPattern:/https:\/\/www\.douyin\.com\/user\/([^/?#]+)/,origins:['creator.douyin.com']},
};

export class BrowserRuntime {
  constructor(dataDir, { launcher = chromium, headless = false, preserveRecoveryWindow = false, identitySelectors = {},pacing={} } = {}) { this.dataDir = dataDir; this.launcher = launcher; this.preserveRecoveryWindow = preserveRecoveryWindow; this.headless = headless; this.identitySelectors = identitySelectors; this.sessions = new Map(); this.opening = new Map();this.modes=new Map();
    this.pacer=operationPacer({enabled:!headless&&process.env.MATRIX_BROWSER_PACE!=='off',minMs:Number(process.env.MATRIX_BROWSER_PACE_MIN_MS??500),maxMs:Number(process.env.MATRIX_BROWSER_PACE_MAX_MS??1400),...pacing});
  }
  async pace(page,kind,options){return this.pacer.wait(page,kind,options);}
  async setMode(account,headless,{restore=true}={}){
    if(this.opening.has(account.id))await this.opening.get(account.id);
    const session=this.sessions.get(account.id);
    this.modes.set(account.id,headless);
    const effectiveHeadless=headless&&!this.preserveRecoveryWindow&&account.platform!=='douyin';
    if(session && session.headless===effectiveHeadless){
      const background=headless&&!effectiveHeadless;
      if(session.background!==background){session.background=background;try{await this.windowState(session,background?'minimized':'normal');}catch{session.background=false;}}
      return false;
    }
    let url=session && !session.page.isClosed()?session.page.url():null;
    if(session)await this.disconnect(account.id);
    const next=await this.open(account,false,!headless);
    if(restore && url){
      const u=new URL(url);
      if(u.protocol==='https:' && routes[account.platform].origins.includes(u.hostname) && next.page.url()!==url)await next.page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    }
    return Boolean(session);
  }
  async windowState(session,state){
    const c=await session.context.newCDPSession(session.page);
    try{const {windowId}=await c.send('Browser.getWindowForTarget');await c.send('Browser.setWindowBounds',{windowId,bounds:{windowState:state}});}finally{await c.detach().catch(()=>{});}
  }
  async reveal(account,page){
    const session=this.sessions.get(account.id);
    if(!session||session.page.isClosed())throw browserError('原任务浏览器已关闭，无法恢复验证页面；请人工核对发布结果。','unknown');
    if(session.headless)throw browserError('旧任务使用无界面浏览器，无法无损显示原验证页。请人工核对结果；新版抖音任务会保留可见窗口。','unknown');
    session.background=false;this.modes.set(account.id,false);await this.windowState({...session,page:page||session.page},'normal');await (page||session.page).bringToFront();return session;
  }
  async open(account, navigate = false, focus = true) {
    if (!routes[account.platform] || !/^[\w-]+$/.test(account.id)) throw browserError('账号环境无效');
    if (this.opening.has(account.id)) return this.opening.get(account.id);
    const work = (async () => {
      let session = this.sessions.get(account.id);
      if (!session) {
        const directory = join(this.dataDir, 'profiles', account.id);
        mkdirSync(directory, { recursive: true });
        let context;
        const silent=this.modes.get(account.id)??this.headless;
        const headless=silent&&!this.preserveRecoveryWindow&&account.platform!=='douyin';
        try { context = await this.launcher.launchPersistentContext(directory, { headless, channel: process.env.MATRIX_BROWSER_CHANNEL || 'chrome', viewport: headless?{width:1360,height:900}:null, acceptDownloads: false }); }
        catch { throw browserError('无法启动账号浏览器。请安装 Chrome，或将 MATRIX_BROWSER_CHANNEL 设为 msedge。请勿同时启动两份工具。'); }
        context.setDefaultTimeout(15000);
        context.setDefaultNavigationTimeout(45000);
        session = { context, headless, background:silent&&!headless, page: context.pages()[0] || await context.newPage() };
        if(session.background)try{await this.windowState(session,'minimized');}catch{session.background=false;}
        session.identityRead=watchCreatorIdentity(session.page,account.platform);
        session.cookieFile = join(directory, 'matrix-session.dpapi');
        if (existsSync(session.cookieFile)) {
          try { const cookies = JSON.parse(protect(readFileSync(session.cookieFile),true)); const current = await context.cookies(); await context.addCookies(cookies.filter(c=>(c.expires === -1 || c.expires > Date.now()/1000) && !current.some(x=>x.name===c.name && x.domain===c.domain && x.path===c.path))); }
          catch { await context.close(); throw browserError('本地加密会话无法恢复，请使用原Windows用户运行工具。'); }
        }
        session.save = async () => {
          const encrypted = protect(Buffer.from(JSON.stringify(await context.cookies())));
          writeFileSync(session.cookieFile+'.tmp',encrypted); renameSync(session.cookieFile+'.tmp',session.cookieFile);
        };
        this.sessions.set(account.id, session);
        context.on('close', () => { if (this.sessions.get(account.id) === session) this.sessions.delete(account.id); });
      }
      if (session.page.isClosed()) {session.page = await session.context.newPage();session.identityRead=watchCreatorIdentity(session.page,account.platform);}
      if (navigate || session.page.url() === 'about:blank') {
        try { await session.page.goto(routes[account.platform].home, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        catch { throw browserError('浏览器已打开，但创作后台加载失败。请检查网络后重试。'); }
      }
      if (focus && !session.headless&&!session.background) await session.page.bringToFront(); return session;
    })();
    this.opening.set(account.id, work);
    try { return await work; } finally { this.opening.delete(account.id); }
  }
  async observeRecovery(account,editor) {
    const session = this.sessions.get(account.id);
    if (!session || session.page.isClosed()) return {human:true};
    const page = session.page;
    const snapshot = await observeRecovery(page,routes[account.platform].origins,editor);
    if (snapshot.human) return snapshot;
    const perform = snapshot.perform;
    snapshot.perform = action => this.sessions.get(account.id)?.page===page && perform(action);
    return snapshot;
  }
  async observeVisualRecovery(account,editor) {
    const session=this.sessions.get(account.id);
    if(!session||session.page.isClosed())return {human:true};
    const page=session.page,snapshot=await observeVisualRecovery(page,routes[account.platform].origins,editor);
    if(!snapshot.human){const perform=snapshot.perform;snapshot.perform=action=>this.sessions.get(account.id)===session&&session.page===page&&perform(action);}
    return snapshot;
  }
  async newSubmissionPage(account) {
    const session = await this.open(account,false,false);
    const page = await session.context.newPage();
    session.page = page;
    session.identityRead = watchCreatorIdentity(page,account.platform);
  }
  async check(account, preserveEditor = false, passive = false) {
    const session = passive ? this.sessions.get(account.id) : await this.open(account, false, false);
    if (!session) throw browserError('请打开账号后台完成扫码', 'needs_login');
    // Keep a single read-only probe per account. Closing a freshly navigated creator
    // page can hang indefinitely in Chrome, even after identity was read correctly.
    // The probe belongs to the context and is disposed with that context instead.
    if(preserveEditor && (!session.identityProbe || session.identityProbe.page.isClosed())){
      const probe=await session.context.newPage();
      session.identityProbe={page:probe,readIdentity:watchCreatorIdentity(probe,account.platform)};
    }
    const page = preserveEditor ? session.identityProbe.page : session.page;
    const since=preserveEditor?Date.now():Date.now()-30000;
    const readIdentity=preserveEditor?session.identityProbe.readIdentity:session.identityRead;
    if (preserveEditor){
      try{await page.goto(routes[account.platform].home, {waitUntil:'domcontentloaded',timeout:45000});}
      catch(e){
        if(!['xhs','douyin'].includes(account.platform))throw e;
        // Client redirects can abort the original navigation after login succeeds.
        if(!/ERR_ABORTED|interrupted by another navigation|context was destroyed/i.test(e.message))throw browserError('账号检查页面加载未完成'+(e.name==='TimeoutError'?'（网络等待超时）':'（网络或浏览器错误）')+'；这不代表登录已失效，请检查网络后重试。','detecting');
      }
    }
    const route = routes[account.platform];
    if(account.platform==='bilibili'){
      const identity=readIdentity?.(since)||await readBilibiliIdentity(page);
      if(identity){
        if(account.platform_id&&account.platform_id!==identity.platformId)throw browserError('当前浏览器身份与绑定B站账号不同，请切回原账号。','identity_mismatch');
        if(session.savedIdentity!==identity.platformId){await session.save();session.savedIdentity=identity.platformId;}
        return identity;
      }
    }
    let creatorMismatch=false;
    if(['xhs','douyin'].includes(account.platform)){
      let identity=await creatorIdentityReady(page,account.platform,readIdentity,since,{timeoutMs:preserveEditor?10000:1500});
      if(identity){
        if(account.platform_id && account.platform_id!==identity.platformId && !identity.aliases?.includes(account.platform_id)){
          if(identity.aliases)throw browserError('当前浏览器身份与绑定账号不同，请切回原账号。','identity_mismatch');
          creatorMismatch=true;
        }else{
          identity={...identity,platformId:account.platform_id||identity.platformId};
          if(session.savedIdentity!==identity.platformId){await session.save();session.savedIdentity=identity.platformId;}
          return identity;
        }
      }
    }
    // The site's current-user endpoint uses this browser's existing login. No developer OAuth is needed.
    // Request only identity fields, never expose credentials or the raw response to logs/UI.
    if (account.platform === 'zhihu' && new URL(page.url()).hostname === 'www.zhihu.com') {
      const me = await page.evaluate(async () => {
        try {
          const r = await fetch('/api/v4/me', {credentials:'include',signal:AbortSignal.timeout(4000)});
          if (!r.ok) return null;
          const d = await r.json();
          return typeof d.id === 'string' && d.id && typeof d.url_token === 'string' && d.url_token ? {platformId:d.url_token,displayName:typeof d.name==='string'?d.name:''} : null;
        } catch { return null; }
      });
      if (me) {
        if (account.platform_id && account.platform_id !== me.platformId) throw browserError('当前浏览器身份与绑定账号不同，请切回原账号。', 'identity_mismatch');
        if (session.savedIdentity !== me.platformId) { await session.save(); session.savedIdentity = me.platformId; }
        return me;
      }
    }
    // Read visible profile links only. Cookie presence alone is not an authenticated identity.
    let links;
    let identityTimer;
    try { const locator = page.locator(this.identitySelectors[account.platform] || route.identity); const reading=locator.evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => ({ href: n.href, name: (n.textContent || '').trim() })));links=await Promise.race([reading,new Promise((_,reject)=>identityTimer=setTimeout(()=>reject(Error('identity timeout')),2000))]); }
    catch { throw browserError('账号检查页尚未就绪，无法读取本人身份；登录状态未被判定失效，请稍后重试或打开后台查看验证提示。', 'detecting'); }
    finally{clearTimeout(identityTimer);}
    const identities = new Map();
    for (const link of links) { const match = link.href?.match(route.identityPattern); if (match) identities.set(match[1], { platformId: match[1], displayName: link.name || account.name }); }
    if (identities.size !== 1){if(creatorMismatch)throw browserError('当前浏览器身份与绑定账号不同，请切回原账号。','identity_mismatch');throw browserError('正在等待登录完成或读取账号信息，暂未取得唯一身份。无需重新扫码；若持续出现请检查后台是否有验证提示。', 'detecting');}
    const identity = [...identities.values()][0];
    if (account.platform_id && account.platform_id !== identity.platformId) throw browserError('当前浏览器身份与绑定账号不同，已阻断操作。请切回原账号。', 'identity_mismatch');
    if (session.savedIdentity !== identity.platformId) { await session.save(); session.savedIdentity=identity.platformId; }
    return identity;
  }
  async disconnect(accountId) {
    if (this.opening.has(accountId)) { try { await this.opening.get(accountId); } catch {} }
    const session = this.sessions.get(accountId); if (session) { try { await session.save(); } finally { await session.context.close(); } } this.sessions.delete(accountId);
  }
  async close() {
    this.pacer.close();
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.sessions.keys()].map(id => this.disconnect(id)));
  }
}

export function loadAdapterRules(root) {
  const file = join(root, 'config', 'adapters.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

export class PublishAdapter {
  constructor(runtime, rules, assetLookup) { this.runtime = runtime; this.rules = rules; this.assetLookup = assetLookup;this.pendingSubmissions=new Map(); }
  async applyAiDisclosure(page,rule,content,{required=true}={}) {
    const {aiAssisted}=publicationOf(content);
    if(aiAssisted===null)return {state:'unchanged',checked:null}; // Older tasks did not specify a declaration.
    if(rule.flow==='bilibili-article')return bilibiliArticleAi(page,aiAssisted,{required});
    if(rule.flow==='bilibili-video')return bilibiliAi(page,aiAssisted,{required});
    if(aiAssisted===false&&(rule.flow==='zhihu-article'||URL.canParse(rule.url)&&['www.zhihu.com','zhuanlan.zhihu.com'].includes(new URL(rule.url).hostname))){
      if(rule.flow==='zhihu-article'&&!rule.aiDisclosure?.selector){
        try{const result=await applyZhihuAi(page,false);if(result)return result;}
        catch(e){if(required)throw e;return {state:'pending',checked:null,evidence:e.message};}
      }
      return zhihuWithoutAi(page,{required});
    }
    if(rule.flow==='douyin')return douyinAi(page,aiAssisted,rule,{required});
    if(rule.flow==='xhs' && !rule.aiDisclosure?.selector){
      const selected=await applyXhsAi(page,aiAssisted);if(selected)return selected;
      try{const result=await applyDeclarationAi(page,aiAssisted,{labelNames:['添加内容类型声明','内容类型声明','作品声明','创作声明','内容声明']});if(result)return {...result,kind:'xhs-declaration'};}
      catch(e){e.message=e.message.replace(/^知乎创作声明/,'小红书作品声明');throw e;}
    }
    if(rule.flow==='zhihu-article' && !rule.aiDisclosure?.selector){
      const result=await applyZhihuAi(page,aiAssisted);
      if(result)return result;
    }
    const name=/AI\s*辅助创作|AI\s*辅助|人工智能生成|AI\s*生成|使用了?\s*AI/i;
    let locator=rule.aiDisclosure?.selector?page.locator(rule.aiDisclosure.selector):page.getByRole('checkbox',{name,hidden:true});
    if(!rule.aiDisclosure?.selector && await locator.count()===0 && rule.flow==='zhihu-article'){
      const panel=await zhihuPanel(page,rule,{open:false});
      const declaration=panel.getByText(/^(创作声明|内容声明|添加创作声明)$/);
      if(await declaration.count()===1)await declaration.click({timeout:5000});
      locator=page.getByRole('checkbox',{name,hidden:true});
      if(await locator.count()===0)locator=page.locator('label').filter({hasText:name}).locator('input[type="checkbox"]');
    }
    const count=await locator.count();
    const native=count===1 && await locator.evaluate(n=>n.tagName==='INPUT'&&n.type==='checkbox');
    if(count!==1 || (!native && !await locator.isVisible())) {
      if(!required)return {state:'pending',checked:null};
      throw browserError('无法唯一定位平台的 AI 辅助创作声明控件，已暂停。请展开发布设置，或完善 aiDisclosure.selector 后再处理。');
    }
    try{
      if(await locator.isChecked({timeout:5000})!==aiAssisted){
        if(!await locator.isEnabled({timeout:5000}))throw Error('disabled');
        if(native && !await locator.isVisible()){
          const label=await locator.evaluate(n=>n.labels?.[0]?.textContent?.trim()||'');
          const target=page.locator('label').filter({hasText:label});
          if(!label || await target.count()!==1)throw Error('label');
          await target.click({timeout:10000});
        }else await locator.setChecked(aiAssisted,{timeout:10000});
      }
      if(await locator.isChecked({timeout:5000})!==aiAssisted)throw Error('mismatch');
    }catch{throw browserError('平台 AI 辅助创作声明无法设置为所选状态，已暂停提交。');}
    return {state:'applied',checked:aiAssisted};
  }
  rule(account, content) {
    const rule = this.rules[account.platform]?.[content.type];
    if (!rule) throw browserError('该平台内容类型尚未配置适配器');
    if (!routes[account.platform].origins.includes(new URL(rule.url).hostname) || !rule.url.startsWith('https://')) throw browserError('发布页必须是对应平台的官方 HTTPS 后台');
    return rule;
  }
  async prepare(account, content, hooks={}) {
    const rule = this.rule(account, content);
    hooks.onProgress?.('切换账号执行环境');
    await this.runtime.setMode?.(account,publicationOf(content).silent,{restore:false});
    hooks.onProgress?.('检查发布账号身份');
    const identity = await this.runtime.check(account,true);
    if (!account.platform_id || identity.platformId !== account.platform_id) throw browserError('请先在账号中心核验并绑定身份');
    const { page } = await this.runtime.open(account);
    const pace=kind=>this.runtime.pace?.(page,kind,{isActive:hooks.isActive});
    hooks.onProgress?.('打开官方发布页面');
    await pace('navigate');
    const sameEditor=rule.flow==='bilibili-article'?bilibiliArticleEditorUrl(page.url()):rule.flow==='zhihu-article'?isZhihuEditor(page.url()):rule.flow==='douyin'?douyinEditorUrl(page.url()):rule.flow==='bilibili-video'?bilibiliEditorUrl(page.url()):rule.flow==='xhs'?xhsEditorUrl(page.url()):page.url().split('?')[0]===rule.url.split('?')[0];
    if(!(hooks.resumeRecovery&&sameEditor))await page.goto(rule.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    hooks.onProgress?.('选择内容发布入口');
    await pace('settings');
    if(rule.flow==='xhs')await xhsMode(page,content.type,rule);
    const version = content.versions?.[account.platform] || {};
    const assets = (content.assetIds || []).map(id => this.assetLookup(id));
    if (assets.some(a => !a)) throw browserError('素材丢失');
    const media = assets.filter(a => content.type === 'video' ? a.mime.startsWith('video/') : a.mime.startsWith('image/'));
    if (media.length && !rule.upload && !contentHtml(content,account.platform)) throw browserError('图片/视频上传定位未配置，请在适配规则中补齐');
    if (rule.upload && media.length) {
      hooks.onProgress?.('上传素材到平台');
      await pace('upload');
      const input = rule.flow==='bilibili-video'?await bilibiliUpload(page,rule):rule.flow==='douyin'?await douyinUpload(page,rule):rule.flow==='xhs'?await xhsUpload(page,content.type,rule):page.locator(rule.upload); if (await input.count() !== 1) throw browserError('无法唯一定位上传控件，请在浏览器检查当前页面');
      const files=rule.flow==='bilibili-video'?bilibiliDiskFiles(media):media.map(a => ({ name: a.name, mimeType: a.mime, buffer: readFileSync(a.path) }));
      await input.setInputFiles(files, { timeout: 30000 });
    }
    let html=contentHtml(content,account.platform);
    if(html){
      html=cleanHtml(html).replace(/src="\/media\/([\w-]+)"/g,(_,assetId)=>{
        const a=this.assetLookup(assetId);if(!a || !/^image\/(png|jpeg|gif|webp)$/.test(a.mime))throw browserError('文章内图片丢失或格式不支持');
        return 'src="data:'+a.mime+';base64,'+readFileSync(a.path).toString('base64')+'"';
      });
    }
    for (const [selector, value,rich] of [[rule.title, version.title || content.title,false], [rule.body, version.body || content.body,Boolean(html)]]) {
      if (!selector) throw browserError('标题/正文定位未配置');
      const kind=selector===rule.title?'title':'body';
      hooks.onProgress?.(kind==='title'?'等待编辑器并填写标题':'填写正文或视频简介');
      await pace('field');
      const field = rule.flow==='bilibili-article'?await bilibiliArticleField(page,kind,rule):rule.flow==='bilibili-video'?await bilibiliField(page,kind,rule):rule.flow==='douyin'?await douyinField(page,kind,rule):rule.flow==='xhs'?await xhsField(page,kind,rule):page.locator(selector); await field.waitFor({ state: 'visible', timeout: 20000 });
      if (await field.count() !== 1) throw browserError('字段存在多个匹配，已暂停以避免填错内容');
      if(rule.flow==='bilibili-article'&&kind==='title'){const max=Number(await field.getAttribute('maxlength'));if(max>0&&String(value||'').length>max)throw browserError('B站长文章标题超过编辑器字数限制，请修改稿件后继续。');}
      if(rich){
        if(!await field.evaluate(n=>n.isContentEditable))throw browserError('平台正文字段不支持富文本，已暂停以避免格式丢失');
        const origin=new URL(page.url()).origin;
        await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
        if(['zhihu-article','bilibili-article'].includes(rule.flow)&&/<img\b/i.test(html))await (rule.flow==='bilibili-article'?pasteBilibiliArticleImages:pasteZhihuImages)(field,html,{pace:()=>pace('upload'),onProgress:message=>hooks.onProgress?.(message)}).catch(error=>{
          if(error.code==='operation_cancelled')throw error;
          if(error.code==='image_upload_failed')throw error;
          throw Object.assign(browserError('文章原生图片导入未完成，请检查图片上传提示或剪贴板权限；未执行发布。'),{code:'image_upload_failed'});
        });
        else {
          await field.click();await field.press('ControlOrMeta+A');await field.press('Backspace');
          await page.evaluate(async html=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'})})]),html);
          await field.press('ControlOrMeta+V');
        }
        await field.page().waitForTimeout(300);
        await assertRich(field,html);
      }else await field.fill(value || '', { timeout: 15000 });
    }
    for(const selector of rule.publishSteps || []) {
      await pace('settings');
      const control=page.locator(selector);
      if(await control.count()!==1)throw browserError('发布设置入口不唯一，已暂停');
      await control.click({timeout:10000});
    }
    if(rule.flow==='bilibili-video'&&content.coverAssetId){hooks.onProgress?.('上传并保存B站视频封面');await pace('upload');await uploadBilibiliCover(page,this.assetLookup(content.coverAssetId));}
    if(rule.flow==='bilibili-article'){await pace('settings');await bilibiliArticleSettings(page);}
    if(rule.flow==='zhihu-article'){await pace('settings');await zhihuPanel(page,rule,{hooks});}
    hooks.onProgress?.('设置平台 AI 创作声明');
    await pace('settings');
    const aiDisclosure=await this.applyAiDisclosure(page,rule,content,{required:false});
    if(rule.flow==='douyin'){await pace('settings');hooks.onProgress?.('设置抖音视频可见范围');await douyinVisibility(page,content.publication?.douyinVisibility,rule);}
    return { page, rule, aiDisclosure };
  }
  async submit(account, content, onClick, hooks={}) {
    const rule = this.rule(account, content);
    const zhihu=rule.flow==='zhihu-article';
    const xhs=rule.flow==='xhs';
    const douyin=rule.flow==='douyin';
    const biliArticle=rule.flow==='bilibili-article';
    const bili=rule.flow==='bilibili-video';
    if (!zhihu && !xhs && !douyin && !bili && !biliArticle && (!rule.submit || !rule.success)) throw browserError('尚未配置唯一提交按钮及成功标志，请在官方后台核对或完善适配规则');
    if (account.status !== 'connected' || !account.platform_id) throw browserError('账号连接已停用或未核验', 'needs_login');
    const { page } = await this.runtime.open(account);
    hooks.onProgress?.('提交前节奏等待与身份复核');
    await this.runtime.pace?.(page,'submit',{isActive:hooks.isActive});
    await this.runtime.check(account, true);
    if (biliArticle?!bilibiliArticleEditorUrl(page.url()):zhihu?!isZhihuEditor(page.url()):bili?!bilibiliEditorUrl(page.url()):douyin?!douyinEditorUrl(page.url()):xhs?!xhsEditorUrl(page.url()):page.url().split('?')[0] !== rule.url.split('?')[0]) throw browserError('发布页面已切换，请人工检查。不会自动重填或提交。');
    if(zhihu)await zhihuPanel(page,rule,{open:false});
    hooks.onProgress?.('核对 AI 创作声明与发布必填项');
    const aiDisclosure=await this.applyAiDisclosure(page,rule,content);
    if(bili){hooks.onProgress?.('核对B站封面');await requireBilibiliCover(page);}
    hooks.onProgress?.('等待平台最终发布按钮可用');
    const button = biliArticle?await bilibiliArticlePublishButton(page,rule):zhihu?await zhihuFinalButton(page,rule):bili?await bilibiliPublishButton(page,rule):douyin?await douyinPublishButton(page,rule):xhs?await xhsPublishButton(page,rule):page.locator(rule.submit);
    if (await button.count() !== 1 || !await button.isEnabled()) throw browserError('提交按钮不唯一或不可用，请检查必填项');
    // Confirm the fields have not been changed since the immutable task snapshot.
    hooks.onProgress?.('核对待发布文案与任务快照');
    const version = content.versions?.[account.platform] || {};
    for (const [selector, expected] of [[rule.title, version.title || content.title], [rule.body, version.body || content.body]]) {
      const kind=selector===rule.title?'title':'body';
      const field = biliArticle?await bilibiliArticleField(page,kind,rule):bili?await bilibiliField(page,kind,rule):douyin?await douyinField(page,kind,rule):xhs?await xhsField(page,kind,rule):page.locator(selector);
      if(selector===rule.body && contentHtml(content,account.platform)){await assertRich(field,cleanHtml(contentHtml(content,account.platform)));continue;}
      const actual = await field.evaluate(n => 'value' in n ? n.value : n.innerText);
      const normalize=s=>s.replace(/\r\n/g,'\n').replace(/\u200b/g,'').replace(/\n+/g,'\n').trim();
      if ((xhs||douyin||bili?normalize(actual):actual.trim()) !== (xhs||douyin||bili?normalize(expected||''):(expected || '').trim())) throw browserError('页面文案已变化，请核对并恢复任务文案后重试');
    }
    if ((biliArticle&&await bilibiliArticleSuccessVisible(page)) || (bili && await bilibiliSuccessVisible(page,rule)) || (douyin && await douyinSuccessVisible(page,rule)) || (xhs && await xhsSuccessVisible(page,rule)) || (rule.success && await page.locator(rule.success).isVisible())) throw browserError('提交前已存在成功标志，无法归因本次提交，已暂停');
    const visibility=douyin?await douyinVisibility(page,content.publication?.douyinVisibility,rule,{verifyOnly:true}):null;
    await onClick();
    if(douyin)this.pendingSubmissions.set(account.id,{page,content:JSON.stringify(content)});

    await button.click({ timeout: 15000 });
    hooks.onProgress?.('已执行最终提交，等待平台回执');
    if(biliArticle)return {...await bilibiliArticleReceipt(page,rule),aiDisclosure};
    if(bili)return {...await bilibiliReceipt(page,rule),aiDisclosure};
    if(douyin){const receipt={...await douyinReceipt(page,rule),aiDisclosure,visibility};this.pendingSubmissions.delete(account.id);return receipt;}
    if(xhs)return {...await xhsReceipt(page,rule),aiDisclosure};
    if(zhihu)return {simulated:false,submittedAt:new Date().toISOString(),aiDisclosure,...await waitZhihuReceipt(page,rule)};
    await page.locator(rule.success).waitFor({ state: 'visible', timeout: 45000 });
    return { simulated: false, id: null, url: null, submittedAt: new Date().toISOString(), aiDisclosure, evidence: '页面显示已配置的提交成功标志；公开状态未确认' };
  }
  async checkResult(account,content){
    if(this.rule(account,content).flow!=='douyin')throw browserError('该平台未开放验证后结果核对。');
    const session=this.runtime.sessions?.get(account.id);
    if(!session||session.page.isClosed())throw browserError('原任务页面已关闭，请到官方后台人工核对，禁止自动重发。','unknown');
    const pending=this.pendingSubmissions.get(account.id);
    if(!pending||pending.page!==session.page||pending.content!==JSON.stringify(content))throw browserError('无法将当前页面归因于该任务的最终提交，请人工核对，禁止自动重发。','unknown');
    const page=session.page,rule=this.rule(account,content);
    if(new URL(page.url()).hostname!=='creator.douyin.com')throw browserError('原发布页面已切换，请人工核对结果。','unknown');
    if(await douyinSuccessVisible(page,rule)){this.pendingSubmissions.delete(account.id);return {state:'submitted',receipt:{simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'人工验证后原任务页面显示发布成功；未重复点击发布，审核与公开状态未确认'}};}
    const verificationPage=await douyinVerificationPage(page);
    return {state:verificationPage?'needs_verification':'pending',verificationPage};
  }
}
