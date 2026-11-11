import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, createWriteStream, createReadStream, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { BrowserRuntime, PublishAdapter, loadAdapterRules } from './browser-runtime.mjs';
import {cleanContent,cleanHtml} from './rich-content.mjs';
import mammoth from 'mammoth';
import {publicationOf,publicationIssues} from './publication.mjs';
import {platforms} from './platform-catalog.mjs';
import {archiveDay, validArchiveDay, referencesAsset} from './asset-library.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const id = () => randomUUID();

export function createStudio({ dataDir = join(root, '.data'), tickMs = 1000, demoDelay = 1100, browserRuntime, publishAdapter } = {}) {
  mkdirSync(join(dataDir, 'assets'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dispatches(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, account_id TEXT NOT NULL, platform TEXT NOT NULL, account_name TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, scenario TEXT NOT NULL, updated TEXT NOT NULL, receipt TEXT, UNIQUE(dispatch_id,account_id));
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL);`);
  for (const [column, type] of [['platform_id','TEXT'], ['checked_at','TEXT']]) {
    if (!db.prepare('PRAGMA table_info(accounts)').all().some(c => c.name === column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${type}`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS asset_dates(asset_id TEXT PRIMARY KEY, day TEXT NOT NULL)');
  const saveDay = db.prepare('INSERT OR IGNORE INTO asset_dates VALUES(?,?)');
  for (const asset of db.prepare('SELECT id,created FROM assets').all()) saveDay.run(asset.id, archiveDay(asset.created));
  const runtime = browserRuntime || new BrowserRuntime(dataDir, { identitySelectors: JSON.parse(readFileSync(join(root,'config','identity-selectors.json'),'utf8')) });
  const adapter = publishAdapter || new PublishAdapter(runtime, loadAdapterRules(root), assetId => {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
    return a && { ...a, path: join(dataDir, 'assets', a.id) };
  });
  let browserBusy = false;
  const browserWaiters=[];
  async function lockBrowser(){
    if(browserBusy)await new Promise(resolve=>browserWaiters.push(resolve));
    else browserBusy=true;
    let released=false;
    return ()=>{if(released)return;released=true;if(browserWaiters.length)browserWaiters.shift()();else browserBusy=false;};
  }
  function event(jobId, state, message) {
    db.prepare('UPDATE jobs SET state=?, updated=? WHERE id=?').run(state, now(), jobId);
    db.prepare('INSERT INTO events(job_id,state,message,created) VALUES(?,?,?,?)').run(jobId, state, message, now());
  }
  // Submissions interrupted by a restart are never retried automatically.
  for (const job of db.prepare("SELECT * FROM jobs WHERE state IN ('uploading','submitting','opening_settings')").all()) {
    const uncertain=job.state!=='uploading';
    event(job.id, uncertain ? 'unknown' : 'queued', uncertain ? '进程重启：发布入口/提交结果待确认，禁止自动重发。' : '进程重启：提交前任务重新排队。');
  }
  for(const job of db.prepare("SELECT * FROM jobs WHERE state='needs_verification'").all())event(job.id,'unknown','进程重启：原验证页面已丢失，请人工核对发布结果，禁止自动重发。');
  db.exec('CREATE TABLE IF NOT EXISTS studio_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (!db.prepare("SELECT value FROM studio_settings WHERE key='accounts_initialized'").get() && !db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n) {
    const insert = db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created) VALUES(?,?,?,?,?,?)');
    insert.run('demo-zhihu', 'zhihu', '知行实验室', 'demo', 'demo', now());
    insert.run('demo-bilibili', 'bilibili', '知行实验室的视频频道', 'demo', 'demo', now());
  }
  db.prepare("INSERT OR IGNORE INTO studio_settings VALUES('accounts_initialized','1')").run();
  const deletingAccounts = new Set();
  const token = randomUUID();
  const timers = new Set();
  let closed = false;
  const watching = new Set();
  const activeTasks=new Map();
  const authChecks=new Map();let monitorBusy=false;
  async function syncIdentity(account, passive = false) {
    if(authChecks.has(account.id))return authChecks.get(account.id);
    const work=(async()=>{
    try {
      const identity = await runtime.check(account, !passive, passive);
      const aliases=[...new Set([identity.platformId,...(identity.aliases||[])])];
      const duplicate = db.prepare(`SELECT id FROM accounts WHERE platform=? AND id<>? AND platform_id IN (${aliases.map(()=>'?').join(',')})`).get(account.platform,account.id,...aliases);
      if (duplicate) throw Object.assign(fail('此平台账号已经绑定另一条记录，请使用原记录',409), {state:'duplicate'});
      if (!closed) db.prepare("UPDATE accounts SET status='connected',platform_id=?,checked_at=? WHERE id=?").run(identity.platformId,now(),account.id);
      return identity;
    } catch(e) {
      if (!closed) db.prepare('UPDATE accounts SET status=?,checked_at=? WHERE id=?').run(e.state || 'detecting',now(),account.id);
      throw e;
    }
    })();
    authChecks.set(account.id,work);
    try{return await work;}finally{authChecks.delete(account.id);}
  }
  const loginMonitor = setInterval(async () => {
    if (closed || browserBusy || monitorBusy || !watching.size) return;
    monitorBusy=true;
    const release=await lockBrowser();
    try {
      for (const accountId of watching) {
        if (closed) break;
        if (runtime.sessions && !runtime.sessions.has(accountId)) { watching.delete(accountId); continue; }
        if (db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','awaiting_confirmation','needs_verification')").get(accountId)) continue;
        const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
        if (!account || account.status==='disconnected') continue;
        try { await syncIdentity(account,true); watching.delete(accountId); } catch {}
      }
    } finally { monitorBusy=false;release(); }
  },2500);
  function later(fn) { const timer = setTimeout(() => { timers.delete(timer); if (!closed) fn(); }, demoDelay); timers.add(timer); }
  function getJob(jobId) { const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId); if (!job) throw fail('任务不存在', 404); return job; }
  function snapshot() {
    return {
      capabilities: { accountDeletion: true },
      platforms,
      accounts: db.prepare('SELECT * FROM accounts ORDER BY created').all(),
      assets: db.prepare('SELECT a.*,d.day AS archiveDate FROM assets a LEFT JOIN asset_dates d ON a.id=d.asset_id ORDER BY d.day DESC,a.created DESC,a.rowid DESC').all(),
      drafts: db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all().map(d => ({ ...JSON.parse(d.data), id: d.id, updated: d.updated })),
      jobs: db.prepare('SELECT j.*,d.snapshot FROM jobs j JOIN dispatches d ON d.id=j.dispatch_id ORDER BY j.rowid DESC').all().map(j => ({ ...j, content: JSON.parse(j.snapshot), receipt: j.receipt ? JSON.parse(j.receipt) : null, events: db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id').all(j.id) })),
    };
  }
  function validate(content, accountIds, {deferIdentity=false}={}) {
    const issues = publicationIssues(content);
    if (!content || !['video', 'article', 'note'].includes(content.type)) return ['请选择内容类型'];
    if (typeof content.title !== 'string' || !content.title.trim()) issues.push('请填写标题');
    if (typeof content.body !== 'string') issues.push('正文格式无效');
    if (content.type !== 'video' && !content.body?.trim()) issues.push('请填写正文');
    const assets = (Array.isArray(content.assetIds) ? content.assetIds : []).map(a => db.prepare('SELECT * FROM assets WHERE id=?').get(a));
    if (assets.some(a => !a)) issues.push('部分素材不存在，请重新选择');
    if(content.coverAssetId){const cover=db.prepare('SELECT * FROM assets WHERE id=?').get(content.coverAssetId);if(content.type!=='video'||!cover||!/^image\/(png|jpeg)$/.test(cover.mime))issues.push('B站封面请选择本地PNG或JPEG图片');}
    if (content.type === 'video' && !assets.some(a => a?.mime.startsWith('video/'))) issues.push('视频任务至少需要一份本地视频素材');
    if (content.type === 'note' && !assets.some(a => a?.mime.startsWith('image/'))) issues.push('图片笔记至少需要一张图片');
    if (!Array.isArray(accountIds) || !accountIds.length) issues.push('请选择目标账号');
    else for (const accountId of new Set(accountIds)) {
      const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
      if (!a) { issues.push('目标账号不存在'); continue; }
      if (deletingAccounts.has(a.id)) { issues.push(a.name+'：账号正在删除，请重新选择'); continue; }
      if (!platforms[a.platform].types.includes(content.type)) issues.push(`${platforms[a.platform].name}：当前路线不支持该内容类型`);
      if(['xhs','douyin'].includes(a.platform)){
        const videos=assets.filter(x=>x?.mime.startsWith('video/')),images=assets.filter(x=>x?.mime.startsWith('image/'));
        if(content.type==='video' && (videos.length!==1||images.length))issues.push(platforms[a.platform].name+'视频任务请仅选择一个视频，封面在后台处理');
        if(a.platform==='xhs' && content.type==='note' && videos.length)issues.push('小红书图片笔记不能混入视频');
      }
      const mayCheck=deferIdentity && !['disconnected','duplicate','identity_mismatch'].includes(a.status) && (watching.has(a.id)||runtime.sessions?.has(a.id)||existsSync(join(dataDir,'profiles',a.id)));
      if (a.mode !== 'demo' && (a.status !== 'connected' || !a.platform_id) && !mayCheck) issues.push(`${a.name}：尚未识别到登录账号。请在专属后台完成扫码或处理验证提示，工具会自动识别`);
      if (a.mode === 'demo' && a.status !== 'demo') issues.push(`${a.name}：请先恢复演示会话`);
    }
    return issues;
  }
  function finishDemo(job) {
    event(job.id,'submitting',publicationOf(JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot)).mode==='auto'?'演示：按所选方式自动提交。':'用户确认演示提交。');
    later(()=>{
      if(getJob(job.id).state!=='submitting')return;
      if(job.scenario==='unknown')return event(job.id,'unknown','演示：提交后连接中断，禁止自动重发。');
      db.prepare('UPDATE jobs SET receipt=? WHERE id=?').run(JSON.stringify({simulated:true,id:`DEMO-${job.id.slice(0,8)}`,submittedAt:now(),url:null}),job.id);
      event(job.id,'demo_submitted','演示提交完成；没有向真实平台发布。');
    });
  }
  async function submitReal(job,account,content,automatic=false) {
    let clicked=false;
    let step='提交前检查';
    try {
      const receipt=await adapter.submit(account,content,()=>{clicked=true;event(job.id,'submitting',automatic?'按任务中用户选择的“工具直接发布”执行最终提交。':'用户确认真实提交；禁止自动重发。');},{onProgress:message=>{step=message;if(!closed)event(job.id,clicked?'submitting':'uploading',message);}});
      if(closed)return;
      db.prepare('UPDATE jobs SET receipt=? WHERE id=?').run(JSON.stringify(receipt),job.id);
      event(job.id,'submitted','平台页面出现提交成功标志；尚未核验审核与公开状态。');
    }catch(e){if(!closed){
      if(clicked&&e.state==='needs_verification'){
        event(job.id,'needs_verification',e.message);
        try{await runtime.reveal(account,e.verificationPage);}catch(revealError){event(job.id,'needs_verification',revealError.message);}
      }else event(job.id,clicked?'unknown':(e.state||'needs_manual'),clicked?`提交结果待确认：${e.message} 请人工检查稿件，禁止自动重发。`:(e.state?e.message:`${step}未完成${e.name==='TimeoutError'?'（等待超时）':''}，请在官方后台核对。`));
    }}
  }
  async function checkVerificationResult(job){
    const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id),content=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
    const result=await adapter.checkResult(account,content);
    if(!['needs_verification','unknown'].includes(getJob(job.id).state))return {ok:true,state:getJob(job.id).state};
    if(result.state==='submitted'){db.prepare('UPDATE jobs SET receipt=? WHERE id=?').run(JSON.stringify(result.receipt),job.id);event(job.id,'submitted','原页面出现发布成功标志；人工验证后未重复点击发布。');}
    else if(result.state==='needs_verification'&&job.state!=='needs_verification'){event(job.id,'needs_verification','仍需人工完成原页面的安全验证，未重新提交。');await runtime.reveal(account,result.verificationPage);}
    return {ok:true,state:getJob(job.id).state,message:result.state==='pending'?'尚未读到发布成功。请继续在原页面处理；工具不会再次点击发布。':result.state==='submitted'?'已读到原页面发布成功。':'请先在原页面完成验证。'};
  }
  const verificationMonitor=setInterval(async()=>{
    if(closed||browserBusy||typeof adapter.checkResult!=='function')return;
    const job=db.prepare("SELECT * FROM jobs WHERE state='needs_verification' ORDER BY updated LIMIT 1").get();if(!job)return;
    const release=await lockBrowser();try{await checkVerificationResult(job);}catch(e){if(!closed)event(job.id,'unknown',e.message);}finally{release();}
  },2000);
  const worker = setInterval(async () => {
    if (closed || browserBusy || authChecks.size) return;
    if (db.prepare("SELECT id FROM jobs WHERE state IN ('uploading','submitting') LIMIT 1").get()) return;
    const job = db.prepare("SELECT * FROM jobs j WHERE state='queued' AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.account_id=j.account_id AND a.state IN ('awaiting_confirmation','needs_verification','unknown','needs_login','identity_mismatch')) ORDER BY rowid LIMIT 1").get();
    if (!job) return;
    if (job.mode !== 'demo') {
      const release=await lockBrowser();
      event(job.id, 'uploading', '开始真实页面准备：检查身份、上传素材并填写。');
      let step='切换账号执行环境';
      const progress=message=>{step=message;if(!closed)event(job.id,'uploading',message);};
      try {
        let account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
        const content = JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
        activeTasks.set(account.id,job.id);
        event(job.id,'uploading',publicationOf(content).silent?(job.platform==='douyin'?'抖音后台最小化执行；出现验证时显示原窗口，等待你完成。':'自动发布使用无界面浏览器，遇到验证请从任务打开可见后台。'):'发布使用可见浏览器。');
        if(account.status==='disconnected')throw Object.assign(fail('账号连接已停用，请重新登录后重试',409),{state:'needs_login'});
        progress('切换账号执行环境');
        await runtime.setMode?.(account,publicationOf(content).silent,{restore:false});
        progress('同步账号身份');
        await syncIdentity(account);
        account=db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);
        const prepared=await adapter.prepare(account, content,{onProgress:progress,onOpening:()=>event(job.id,'opening_settings','按语义定位打开知乎发布入口，等待确认设置面板；未确认前禁止重发。'),onOpened:()=>event(job.id,'uploading','已确认知乎发布设置面板打开，尚未进行最终提交。')});
        if (!closed) {
          if(prepared?.aiDisclosure)event(job.id,'uploading',prepared.aiDisclosure.evidence||(prepared.aiDisclosure.state==='pending'?'AI声明尚未匹配，最终提交前必须确认所选状态。':`AI声明处理：${prepared.aiDisclosure.checked===null?'沿用旧任务状态':prepared.aiDisclosure.checked?'勾选':'不勾选'}。`));
          if(publicationOf(content).mode==='auto')await submitReal(job,account,content,true);
          else event(job.id, 'awaiting_confirmation', '按所选方式暂停，等待人工处理封面、分区和声明，完成后确认提交。');
        }
      } catch (e) { if (!closed) event(job.id, e.state==='detecting'?'needs_manual':e.state || 'needs_manual', e.state ? e.message : `${step}未完成${e.name==='TimeoutError'?'（等待超时）':''}，请打开任务浏览器检查。`); }
      finally { release(); }
      return;
    }
    if (job.scenario === 'login') { event(job.id, 'needs_login', '演示：会话失效，任务暂停。请点击“恢复演示会话”。'); return; }
    event(job.id, 'uploading', '演示：模拟上传；素材不会发送到任何社交平台。');
    later(() => { if (getJob(job.id).state !== 'uploading')return;
      const content=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
      if(publicationOf(content).mode==='auto')finishDemo(job);else event(job.id, 'awaiting_confirmation', '演示：填写完成，等待核对账号和平台文案。');
    });
  }, tickMs);

  async function jsonBody(req) {
    let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw fail('内容超过32MB，请压缩文章图片', 413); }
    try { return JSON.parse(data || '{}'); } catch { throw fail('JSON 格式无效'); }
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const base = `http://${req.headers.host}`;
      const url = new URL(req.url, base);
      const host = req.headers.host || '';
      if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) throw fail('只允许本机访问', 403);
      if (req.headers.origin && req.headers.origin !== base) throw fail('不接受跨站请求', 403);
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method !== 'GET') {
          const supplied = Buffer.from(req.headers['x-studio-token'] || ''); const expected = Buffer.from(token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('本地会话无效，请刷新页面', 403);
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return send(200, { ...snapshot(), token });
        if (req.method === 'POST' && url.pathname === '/api/assets') {
          const name = decodeURIComponent(req.headers['x-file-name'] || '');
          const mime = String(req.headers['content-type'] || '').split(';')[0];
          if (!name || name.length > 240 || !/^(video|image)\//.test(mime)) throw fail('请选择图片或视频文件');
          const day = req.headers['x-archive-date'] || archiveDay();
          if (!validArchiveDay(day)) throw fail('归档日期无效，请使用有效的 YYYY-MM-DD 日期');
          const assetId = id(); const path = join(dataDir, 'assets', assetId); let size = 0;
          try {
            await pipeline(req, new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > 512 * 1024 * 1024 ? fail('单文件上限为512MB（展示版限制）', 413) : null, chunk); } }), createWriteStream(path, { flags: 'wx' }));
            if (!size) throw fail('文件为空');
            db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(assetId, name, mime, size, now());
            db.prepare('INSERT INTO asset_dates VALUES(?,?)').run(assetId, day);
          } catch (e) { if (existsSync(path)) unlinkSync(path); throw e; }
          return send(201, { id: assetId });
        }
        if(req.method==='POST' && url.pathname==='/api/import-word') {
          const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw fail('Word文件上限20MB',413);chunks.push(chunk);}
          try {
            const buffer=Buffer.concat(chunks);
            const result=await mammoth.convertToHtml({buffer},{convertImage:mammoth.images.imgElement(async image=>({src:'data:'+image.contentType+';base64,'+await image.read('base64')}))});
            const plain=await mammoth.extractRawText({buffer});
            return send(200,{html:cleanHtml(result.value),text:plain.value,warnings:result.messages.map(m=>m.message)});
          }catch{throw fail('无法导入，请选择有效的.docx文件（不支持旧版.doc）');}
        }
        const body = req.method === 'POST' ? await jsonBody(req) : {};
        if(body.content)body.content=cleanContent(body.content);
        const assetAction = url.pathname.match(/^\/api\/assets\/([\w-]+)$/);
        if (assetAction && ['POST','DELETE'].includes(req.method)) {
          const assetId = assetAction[1];
          const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
          if (!asset) throw fail('素材不存在', 404);
          if (req.method === 'DELETE') {
            const drafts = db.prepare('SELECT data FROM drafts').all().filter(d => referencesAsset(JSON.parse(d.data), assetId));
            const jobs = db.prepare("SELECT d.snapshot FROM jobs j JOIN dispatches d ON d.id=j.dispatch_id WHERE j.state NOT IN ('submitted','demo_submitted','cancelled','manually_closed')").all().filter(j => referencesAsset(JSON.parse(j.snapshot), assetId));
            if (drafts.length || jobs.length) throw fail('素材被 '+drafts.length+' 份草稿、'+jobs.length+' 个未结束任务引用，请先在草稿中移除素材或结束相关任务后再删除', 409);
            const file = join(dataDir, 'assets', assetId);
            const cacheRoot = resolve(dataDir, 'assets', '.browser-upload');
            const cache = resolve(cacheRoot, assetId);
            if (dirname(cache) !== cacheRoot) throw fail('素材缓存路径无效');
            rmSync(cache, { recursive: true, force: true });
            if (existsSync(file)) unlinkSync(file);
            db.prepare('DELETE FROM asset_dates WHERE asset_id=?').run(assetId);
            db.prepare('DELETE FROM assets WHERE id=?').run(assetId);
            return send(200, { deleted: assetId });
          }
          const name = body.name === undefined ? asset.name : body.name;
          if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\\/\x00-\x1f]/.test(name)) throw fail('素材名称须为1–240个字符，不能包含路径或控制字符');
          if (extname(name.trim()).toLowerCase() !== extname(asset.name).toLowerCase()) throw fail('请保留原文件扩展名');
          const day = body.archiveDate === undefined ? (db.prepare('SELECT day FROM asset_dates WHERE asset_id=?').get(assetId)?.day || archiveDay(asset.created)) : body.archiveDate;
          if (!validArchiveDay(day)) throw fail('归档日期无效，请使用有效的 YYYY-MM-DD 日期');
          db.prepare('UPDATE assets SET name=? WHERE id=?').run(name.trim(), assetId);
          db.prepare('INSERT INTO asset_dates VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET day=excluded.day').run(assetId, day);
          return send(200, { id: assetId });
        }
        if (req.method === 'POST' && url.pathname === '/api/accounts') {
          if (!platforms[body.platform] || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw fail('请填写平台和账号名称（80字内）');
          const accountId = id();
          db.prepare('INSERT INTO accounts(id,platform,name,mode,status,created) VALUES(?,?,?,?,?,?)').run(accountId, body.platform, body.name.trim(), 'browser', 'pending', now());
          return send(201, { id: accountId, message: '已建立独立账号。点击“登录 / 打开后台”后扫码，工具会自动识别。' });
        }
        const accountDelete = url.pathname.match(/^\/api\/accounts\/([\w-]+)$/);
        if (req.method === 'DELETE' && accountDelete) {
          const accountId = accountDelete[1];
          const release = await lockBrowser();
          try {
            const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
            if (!account) throw fail('账号不存在或已删除', 404);
            const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE account_id=? AND state NOT IN ('submitted','demo_submitted','cancelled','manually_closed')").get(accountId).n;
            if (pending) throw fail('该账号还有 '+pending+' 个未结束任务，请先取消任务或核对结果并关闭任务后再删除', 409);
            deletingAccounts.add(accountId);
            if (authChecks.has(accountId)) try { await authChecks.get(accountId); } catch {}
            if (account.mode !== 'demo') await runtime.disconnect(accountId);
            const profiles = resolve(dataDir, 'profiles');
            const profile = resolve(profiles, accountId);
            if (dirname(profile) !== profiles) throw fail('账号目录无效');
            rmSync(profile, { recursive: true, force: true });
            watching.delete(accountId);activeTasks.delete(accountId);runtime.modes?.delete(accountId);
            db.prepare('DELETE FROM accounts WHERE id=?').run(accountId);
            return send(200, { deleted: accountId, message: '账号及本机登录环境已删除，历史任务记录保留。' });
          } finally { deletingAccounts.delete(accountId);release(); }
        }
        const accountMatch = url.pathname.match(/^\/api\/accounts\/([\w-]+)\/(open|check|disconnect)$/);
        if (req.method === 'POST' && accountMatch) {
          let account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountMatch[1]);
          if (!account || account.mode === 'demo') throw fail('请选择真实账号记录', 404);
          const release=await lockBrowser();
          try {
            account=db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);
            if (!account) throw fail('账号不存在或已删除', 404);
            if (accountMatch[2] !== 'open' && db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','opening_settings','awaiting_confirmation','needs_verification','unknown')").get(account.id)) throw fail('账号有待处理发布任务，请先核对或取消任务', 409);
            if (accountMatch[2] === 'open') {
              if (db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting')").get(account.id)) throw fail('账号正在发布准备，请稍后打开',409);
              if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('awaiting_confirmation','needs_verification','unknown')").get(account.id))throw fail('请从待处理任务点击“打开任务浏览器”进行接管',409);
              await runtime.setMode?.(account,false);await runtime.open(account, false); watching.add(account.id);
              db.prepare("UPDATE accounts SET status=CASE WHEN status='connected' THEN status ELSE 'detecting' END WHERE id=?").run(account.id);
              return send(200, {message:'后台已打开。扫码后自动识别账号，无需手动核验。'});
            }
            if (accountMatch[2] === 'disconnect') { watching.delete(account.id); if(authChecks.has(account.id))try{await authChecks.get(account.id);}catch{} await runtime.disconnect(account.id); db.prepare("UPDATE accounts SET status='disconnected' WHERE id=?").run(account.id); return send(200, {message:'已关闭浏览器并停用任务。登录环境保留在本机；这不等于平台退出登录。'}); }
            try {
              watching.add(account.id);
              await syncIdentity(account);
              return send(200, {message:'登录身份已核验并绑定。会话失效时请重新扫码。'});
            } catch(e) { db.prepare('UPDATE accounts SET status=?,checked_at=? WHERE id=?').run(e.state || 'needs_login', now(), account.id); throw e; }
          } finally { release(); }
        }
        if (req.method === 'POST' && url.pathname === '/api/drafts') {
          if (!body.content || typeof body.content.title !== 'string') throw fail('草稿无效');
          const draftId = typeof body.id === 'string' ? body.id : id();
          db.prepare('INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated').run(draftId, JSON.stringify(body.content), now());
          return send(200, { id: draftId });
        }
        if (req.method === 'POST' && url.pathname === '/api/validate') return send(200, { issues: validate(body.content, body.accountIds) });
        if (req.method === 'POST' && url.pathname === '/api/dispatch') {
          if (typeof body.requestKey !== 'string' || body.requestKey.length > 100) throw fail('缺少分发意图标识');
          const prior = db.prepare('SELECT * FROM dispatches WHERE request_key=?').get(body.requestKey);
          if (prior) return send(200, { id: prior.id, reused: true });
          // Persist the intent immediately. Browser and identity work belongs to the worker,
          // so another upload or QR scan never rejects a new dispatch or changes its page.
          const issues = validate(body.content, body.accountIds,{deferIdentity:true}); if (issues.length) return send(422, { error: '校验未通过', issues });
          const dispatchId = id();
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('INSERT INTO dispatches VALUES(?,?,?,?)').run(dispatchId, body.requestKey, JSON.stringify(body.content), now());
            for (const accountId of new Set(body.accountIds)) {
              const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId); const jobId = id();
              db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(jobId, dispatchId, a.id, a.platform, a.name, a.mode, 'queued', ['normal', 'login', 'unknown'].includes(body.scenario) ? body.scenario : 'normal', now(), null);
              const p=publicationOf(body.content);
              event(jobId, 'queued', `${a.mode==='demo'?'演示任务':'真实任务'}：${p.mode==='auto'?'工具直接发布':'发布前人工处理'}；AI辅助创作：${p.aiAssisted===null?'旧任务未指定':p.aiAssisted?'勾选':'不勾选'}。已保存内容和选项快照，执行器繁忙时自动排队，执行时核验账号。`);
            }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          return send(201, { id: dispatchId });
        }
        const match = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(confirm|cancel|resume|resolve|inspect|retry|check-result)$/);
        if (req.method === 'POST' && match) {
          const job = getJob(match[1]); const action = match[2];
          if(action==='check-result'){
            if(job.platform!=='douyin'||!['needs_verification','unknown'].includes(job.state)||!db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id))throw fail('只能核对抖音已尝试提交的原任务结果',409);
            if(browserBusy)throw fail('执行器正忙，请稍后核对',409);const release=await lockBrowser();try{return send(200,await checkVerificationResult(job));}finally{release();}
          }
          if(action==='retry'){
            const snapshot=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
            const canResumeAuto=job.state==='awaiting_confirmation' && publicationOf(snapshot).mode==='auto';
            if((!['needs_manual','needs_login'].includes(job.state)&&!canResumeAuto) || db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id))throw fail('只可重试尚未提交的失败任务；提交结果未知时禁止重发',409);
            if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','opening_settings','awaiting_confirmation','needs_verification','unknown') AND id<>?").get(job.account_id,job.id))throw fail('同账号还有待处理任务，请先核对',409);
            event(job.id,'queued','用户重试未提交任务，保留原内容和发布选项；准备流程将重新执行。');return send(200,{ok:true});
          }
          if (action === 'inspect') {
            if (job.mode === 'demo') throw fail('演示任务没有真实浏览器');
            if (browserBusy) throw fail('浏览器正在执行操作，请稍后', 409);
            if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND id<>? AND state IN ('uploading','submitting','opening_settings','awaiting_confirmation','needs_verification','unknown')").get(job.account_id,job.id))throw fail('同账号还有其他待处理或结果未知的任务，请先处理该任务，避免覆盖其发布页面',409);
            const release=await lockBrowser();
            const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
            try {
              if (!account) throw fail('该任务的账号已删除，历史记录仅供查看', 409);
              const attempted=db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id);
              if(attempted){await runtime.reveal(account);return send(200,{ok:true});}
              const hadSession=Boolean(runtime.sessions?.has(account.id));
              const wasHidden=runtime.sessions?.get(account.id)?.headless;
              const switched=await runtime.setMode?.(account,false);
              if(!attempted && ['needs_manual','awaiting_confirmation','needs_login'].includes(job.state) && (!hadSession || switched || wasHidden || activeTasks.get(account.id)!==job.id)){
                const c=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
                const manual={...c,publication:{...c.publication,mode:'manual',silent:false}};
                activeTasks.set(account.id,job.id);
                try{
                  await adapter.prepare(account,manual,{onOpening:()=>event(job.id,'opening_settings','人工接管时打开发布入口，等待确认。'),onOpened:()=>event(job.id,'uploading','已确认发布设置打开。')});
                  event(job.id,'awaiting_confirmation','已切换可见浏览器并恢复该任务原文，等待人工处理；不会自动提交。');
                }catch(e){event(job.id,e.state==='detecting'?'needs_manual':e.state||'needs_manual',e.state?e.message:'已打开可见浏览器，请检查页面。');}
              }
              await runtime.open(account);return send(200, {ok:true});
            } finally { release(); }
          }
          if (action === 'confirm') {
            if (job.state !== 'awaiting_confirmation') throw fail('任务当前不可确认', 409);
            if (browserBusy) throw fail('执行器正忙',409);
            if (job.mode !== 'demo') {
              if (body.confirmReal !== true) throw fail('请明确确认真实发布', 409);
              if (browserBusy) throw fail('执行器正忙', 409);
              const release=await lockBrowser();
              try {
                const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
                const content = JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
                await submitReal(job,account,content);
              }
              finally { release(); }
              return send(200, {ok:true});
            }
            if (db.prepare("SELECT id FROM jobs WHERE state IN ('uploading','submitting') LIMIT 1").get()) throw fail('执行器正忙，请稍后确认', 409);
            finishDemo(job);
          } else if (action === 'cancel') {
            if (job.mode !== 'demo' && job.state === 'uploading') throw fail('正在填写页面，请等待执行完成后取消', 409);
            if (!['queued', 'uploading', 'awaiting_confirmation', 'needs_login','needs_manual','identity_mismatch'].includes(job.state)) throw fail('提交后不可取消或重发，请核对结果', 409);
            event(job.id, 'cancelled', '用户取消了提交前任务。');
          } else if (action === 'resume') {
            if (job.state !== 'needs_login' || job.mode !== 'demo') throw fail('任务不可恢复', 409);
            db.prepare("UPDATE jobs SET scenario='normal' WHERE id=?").run(job.id); event(job.id, 'queued', '演示会话已恢复，重新排队。');
          } else {
            if (!['unknown','needs_verification','needs_manual','identity_mismatch'].includes(job.state)) throw fail('任务当前无需人工核对', 409);
            event(job.id, 'manually_closed', '用户已人工核对并关闭任务；未生成平台回执，不代表发布成功。');
          }
          return send(200, { ok: true });
        }
        throw fail('接口不存在', 404);
      }
      if (req.method !== 'GET') throw fail('方法不支持', 405);
      const assetMatch = url.pathname.match(/^\/media\/([\w-]+)$/);
      if (assetMatch) {
        const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetMatch[1]); if (!asset) throw fail('素材不存在', 404);
        // Only raster formats and videos are rendered inline; SVG/HTML cannot execute on the local origin.
        const mime = /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|ogg))$/.test(asset.mime) ? asset.mime : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': asset.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return createReadStream(join(dataDir, 'assets', asset.id)).pipe(res);
      }
      const files = { '/': 'index.html', '/app.js': 'app.js', '/editor.bundle.js':'editor.bundle.js', '/style.css': 'style.css' }; const file = files[url.pathname];
      if (!file) throw fail('页面不存在', 404);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(readFileSync(join(root, 'public', file)));
    } catch (e) { if (!res.headersSent && !res.destroyed) send(e.status || 500, { error: e.status ? e.message : '本地服务出错，请检查服务终端' }); else if (!res.destroyed) res.end(); }
  });
  return { server, db, close: async () => { closed = true; clearInterval(worker); clearInterval(loginMonitor);clearInterval(verificationMonitor); for (const timer of timers) clearTimeout(timer); await runtime.close(); await new Promise(r => server.close(r)); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318); const studio = createStudio();
  studio.server.listen(port, '127.0.0.1', () => console.log(`Matrix Studio 本地预览：http://127.0.0.1:${port}\n演示账号仅模拟；真实账号会操作官方后台，最终提交需确认。`));
  studio.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可设置 PORT 后重启。` : e.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await studio.close(); process.exit(0); });
}
