import {imageSettings} from './workflow/image-search.mjs';
import {videoSettings} from './workflow/video-settings.mjs';
import {modelSettings} from './workflow/model-settings.mjs';
import {sourceMedia} from './workflow/source-media.mjs';
import {publicationActions} from './workflow/publication-actions.mjs';
import {workflowTools} from './workflow/tools.mjs';
import {inspectGeneratedVideo} from './workflow/video-inspection.mjs';
import {videoJobs} from './workflow/video-model.mjs';
import {renderNoteCard} from './workflow/note-card.mjs';
import {imageTextStore,readImageText} from './workflow/image-text.mjs';
import {publicationPolicy} from './workflow/publication-policy.mjs';
import {macroWorkflow} from './workflow/macro-workflow.mjs';
import {recoveryRunner} from './workflow/recovery-runner.mjs';
import {preparationGoal} from './workflow/coordinate-recovery.mjs';
import { absenceEvidence, attemptsFor } from './workflow/retry-evidence.mjs';
import {creatorReader,workId} from './workflow/creator-reader.mjs';
import { publicationMonitor } from './workflow/publication-monitor.mjs';
import { createDispatchService } from './dispatch-service.mjs';
import { submissionService } from './submission-service.mjs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync,writeFileSync,renameSync, existsSync, createWriteStream, createReadStream, unlinkSync, rmSync } from 'node:fs';
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

export function createStudio({ dataDir = join(root, '.data'), tickMs = 1000, demoDelay = 1100, browserRuntime, publishAdapter, verifier, model, writer, recognize=readImageText, imageProvider, renderCard=renderNoteCard, videoProvider, videoCallMicros=Number(process.env.MATRIX_VIDEO_CALL_MICROS??0), videoBudgetMicros=Number(process.env.MATRIX_VIDEO_BUDGET_MICROS??0), writerCallMicros=Number(process.env.MATRIX_WRITER_CALL_MICROS??0), recoveryLimits={maxCalls:Number(process.env.MATRIX_RECOVERY_MAX_CALLS ?? 4),maxSeconds:Number(process.env.MATRIX_RECOVERY_MAX_SECONDS ?? 180),maxMicros:process.env.MATRIX_RECOVERY_MAX_MICROS ? Number(process.env.MATRIX_RECOVERY_MAX_MICROS) : null,callMicros:Number(process.env.MATRIX_MODEL_CALL_MICROS ?? 0)}, clock = now } = {}) {
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
  db.exec('CREATE TABLE IF NOT EXISTS asset_notes(asset_id TEXT PRIMARY KEY, note TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS asset_dates(asset_id TEXT PRIMARY KEY, day TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS asset_sources(asset_id TEXT PRIMARY KEY,source TEXT NOT NULL)');
  const saveDay = db.prepare('INSERT OR IGNORE INTO asset_dates VALUES(?,?)');
  for (const asset of db.prepare('SELECT id,created FROM assets').all()) saveDay.run(asset.id, archiveDay(asset.created));
  const models=modelSettings(db);
  const videoModels=videoSettings(db);
  const images=imageSettings(db);
  const videoReady=()=>videoProvider!==undefined?!!videoProvider:videoModels.view().configured;
  model ??= models.planner;
  writer ??= models.writer;
  const modelReady=()=>!!model && model.available!==false;
  const writerReady=()=>!!writer && writer.available!==false;
  const generate=async(observation,options)=>{
    const agent=models.capture(),delegate=observation.generationModelId?models.capture(observation.generationModelId):null;
    const imageService=imageProvider??images.capture();
    const pictorial=observation.target.type!=='video',search=pictorial&&observation.imageSearch?.enabled,research=pictorial&&observation.webResearch===true;
    const readReferences=search&&observation.imageSearch.useReferenceImages&&observation.assets.some(a=>a.mime.startsWith('image/'));
    if(observation.sourceMode==='content'||readReferences){
      if(writer===models.writer && !agent.vision)throw Error('vision_required');
      observation={...observation,assets:await sourceMedia(observation.assets,id=>join(dataDir,'assets',id),options.signal)};
    }
    if(search||research){
      if(!agent.imageQueries||!imageService)throw Error('image_search_failed');
      const plan=await agent.imageQueries(observation,options);options.signal.throwIfAborted();
      if(typeof plan.visualSummary!=='string'||plan.visualSummary.length>1500)throw Error('image_search_failed');
      let candidates=[];
      try{
        if(imageService.research){
          const result=await imageService.research(plan.queries,{signal:options.signal,limit:observation.imageSearch?.maxImages||3,images:search,reserveCall:options.reserveSearchCall});
          if(research){options.onResearch?.(result.sources);observation={...observation,researchSources:result.sources};}
          candidates=result.images;
        }else if(research)throw Object.assign(Error('domestic_search_unconfigured'),{code:'domestic_search_unconfigured'});
        else candidates=await imageService.search(plan.queries,{signal:options.signal,limit:observation.imageSearch.maxImages,reserveCall:options.reserveSearchCall});
      }catch(error){options.signal.throwIfAborted();throw Error(error.code||'image_search_failed');}
      if(search&&(!Array.isArray(candidates)||!candidates.length))throw Error('image_search_empty');
      const fetched=[];
      for(const candidate of (search?candidates:[]).slice(0,observation.imageSearch?.maxImages||3)){
        options.signal.throwIfAborted();let result;
        try{result=await imageService.download(candidate,{signal:options.signal});}catch{options.signal.throwIfAborted();continue;}
        options.signal.throwIfAborted();if(closed)throw Error('closed');
        if(!Buffer.isBuffer(result.bytes)||result.bytes.length>10*1024*1024||!/^image\/(png|jpeg|webp)$/.test(result.mime))continue;
        const source={provider:candidate.provider||'wikimedia-commons',pageUrl:candidate.pageUrl,imageUrl:candidate.imageUrl,author:candidate.author,license:candidate.license,licenseUrl:candidate.licenseUrl,description:candidate.description,query:candidate.query,retrievedAt:clock()};
        const id='search-'+createHash('sha256').update(candidate.pageUrl).update(result.bytes).digest('hex').slice(0,40);
        const imageName=String(candidate.name||'资料配图').replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\.(png|jpe?g|webp)$/i,'').trim().slice(0,190)+(result.mime==='image/png'?'.png':result.mime==='image/webp'?'.webp':'.jpg');
        const asset={id,name:imageName,mime:result.mime,note:'资料配图：'+candidate.description,description:candidate.description,source};
        if(!db.prepare('SELECT 1 FROM assets WHERE id=?').get(id)){
          const path=join(dataDir,'assets',id),tmp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,result.bytes,{flag:'wx'});renameSync(tmp,path);}finally{if(existsSync(tmp))unlinkSync(tmp);}
          db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(id,asset.name,result.mime,result.bytes.length,clock());db.prepare('INSERT INTO asset_dates VALUES(?,?)').run(id,archiveDay(clock()));db.prepare('INSERT INTO asset_notes VALUES(?,?)').run(id,asset.note.slice(0,2000));db.prepare('INSERT INTO asset_sources VALUES(?,?)').run(id,JSON.stringify(source));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        }
        fetched.push(asset);
      }
      if(search&&!fetched.length)throw Error('image_search_empty');
      const combined=[...observation.assets];for(const asset of fetched)if(!combined.some(a=>a.id===asset.id))combined.push(asset);options.onAssets?.(fetched);observation={...observation,assets:combined,visualSummary:plan.visualSummary};
    }
    options.signal.throwIfAborted();
    if(!delegate){const output=await (writer===models.writer?agent.writer(observation,options):writer(observation,options));return {...output,agentModelId:agent.id};}
    const plan=await agent.promptAgent(observation,options);
    if(typeof plan?.prompt!=='string'||!plan.prompt.trim()||plan.prompt.length>6000)throw Error('invalid_generation_prompt');
    options.signal.throwIfAborted();
    const assets=observation.assets.map(({previews,...asset})=>delegate.vision?{...asset,previews}:asset);
    const draft=await delegate.writer({...observation,assets,generatedPrompt:plan.prompt},options);
    options.signal.throwIfAborted();options.onDraft?.(draft);
    let output=draft;
    if(pictorial&&observation.editorialReview){
      output=await agent.editor({...observation,draft,feedback:'将外接模型初稿审改为适合此社交平台的图文报道'},options);
      options.signal.throwIfAborted();
      if(typeof output.reviewNotes!=='string'||output.reviewNotes.length>2000)throw Error('invalid_editorial_review');
    }
    return {...output,generationPrompt:plan.prompt,agentModelId:agent.id,generationModelId:delegate.id};
  };
  Object.defineProperty(generate,'available',{get:writerReady});
  Object.defineProperty(generate,'reviewAvailable',{get:()=>models.view().configured});
  generate.callCount=(spec,target)=> (spec.generationModelId?(spec.editorialReview&&target?.type!=='video'?3:2):1)+((spec.imageSearch?.enabled||spec.webResearch)&&target?.type!=='video'?1:0);
  generate.validate=(spec,target)=>{
    if(!imageProvider&&target?.type!=='video'&&(spec.imageSearch?.enabled||spec.webResearch)&&!images.view().configured)throw Error('missing_search_key');
    if(spec.webResearch&&target?.type!=='video'&&!imageProvider&&images.view().provider!=='deepseek')throw Error('domestic_search_unconfigured');
    const imageReferences=target?.type!=='video'&&spec.imageSearch?.enabled&&spec.imageSearch.useReferenceImages&&spec.assetIds.some(id=>db.prepare('SELECT mime FROM assets WHERE id=?').get(id)?.mime.startsWith('image/'));
    if((spec.sourceMode==='content'||imageReferences)&&writer===models.writer&&!models.view().vision)throw Error('vision_required');
    if(spec.generationModelId){let agent,delegate;try{agent=models.capture();delegate=models.capture(spec.generationModelId);}catch{throw Error('missing_generation_model');}if(!agent.promptAgent||!delegate.writer)throw Error('missing_generation_model');}
  };
  generate.revise=async(observation,options)=>{const agent=models.capture();if(!agent.editor)throw Error('missing_model');const prepared=observation.sourceMode==='content'&&agent.vision?{...observation,assets:await sourceMedia(observation.assets,id=>join(dataDir,'assets',id),options.signal)}:observation;const output=await agent.editor(prepared,options);options.signal.throwIfAborted();return {...output,agentModelId:agent.id};};
  const runtime = browserRuntime || new BrowserRuntime(dataDir, { preserveRecoveryWindow:true, identitySelectors: JSON.parse(readFileSync(join(root,'config','identity-selectors.json'),'utf8')) });
  const readers=new Map(),readerStatus={};
  for(const platform of Object.keys(platforms)) {
    const path=join(dataDir,platform+'-verifier.json');
    readerStatus[platform]='unconfigured';
    if(!existsSync(path)) continue;
    try {
      readers.set(platform,creatorReader(runtime,platform,JSON.parse(readFileSync(path,'utf8'))));
      readerStatus[platform]='configured';
    } catch {readerStatus[platform]='invalid_config';}
  }
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
  const dispatch = createDispatchService({ db, validate, event, fail, id, now });
  const beginSubmission = submissionService(db, event, clock);
  // Submissions interrupted by a restart are never retried automatically.
  for (const job of db.prepare("SELECT * FROM jobs WHERE state IN ('uploading','submitting','opening_settings')").all()) {
    const uncertain=job.state!=='uploading';
    event(job.id, uncertain ? 'unknown' : 'queued', uncertain ? (getIntent(job.id)?.next_check_at ? '进程重启：任务保留已用名额，将按保存策略核对稿件。' : '进程重启：发布入口/提交结果待确认，禁止自动重发。') : '进程重启：提交前任务重新排队。');
  }
  for(const job of db.prepare("SELECT * FROM jobs WHERE state='needs_verification'").all()) {
    db.prepare("UPDATE publication_intents SET status='requires_human',next_check_at=NULL,version=version+1 WHERE job_id=?").run(job.id);
    event(job.id,'unknown','进程重启：原验证页面已丢失，请人工核对发布结果，禁止自动重发。');
  }
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
  const recovery=recoveryRunner({db,model,runtime,lockBrowser,event,isClosed:()=>closed,clock,limits:recoveryLimits});
  for (const job of db.prepare("SELECT id FROM jobs WHERE state='recovering'").all())
    event(job.id,'needs_manual','进程重启，恢复动作已失效；请重新观察账号页面。');
  const imageText=imageTextStore({db,clock,recognize,pathFor:id=>join(dataDir,'assets',id),isClosed:()=>closed});
  const generateVideo=videoJobs({db,resolveProvider:id=>videoProvider!==undefined?{provider:videoProvider,callMicros:videoCallMicros,maxMicros:videoBudgetMicros}:videoModels.capture(id),clock,isClosed:()=>closed});
  const macros=macroWorkflow({db,clock,videoProfileId:id=>videoProvider!==undefined?null:videoModels.resolveId(id),writer:generate,imageText,publicationSummary:getIntent,dispatch,isClosed:()=>closed,callMicros:writerCallMicros,
    makeCard:(artifact,signal)=>{
      const asset=db.prepare('SELECT id,mime,size FROM assets WHERE id=?').get(artifact.assetIds[0]);
      if(!asset || asset.size>32*1024*1024)throw Error('invalid_card_asset');
      return renderCard({path:join(dataDir,'assets',asset.id),mime:asset.mime,title:artifact.title,signal});
    },
    storeCard:(targetId,title,bytes)=>{
      if(!Buffer.isBuffer(bytes) || bytes.length<24 || bytes.toString('hex',0,8)!=='89504e470d0a1a0a' ||
          bytes.readUInt32BE(16)!==1080 || bytes.readUInt32BE(20)!==1440)throw Error('invalid_card_output');
      const id='card-'+targetId,path=join(dataDir,'assets',id),tmp=path+'.'+randomUUID()+'.tmp';
      const at=clock();
      try {writeFileSync(tmp,bytes,{flag:'wx'});renameSync(tmp,path);}
      finally {if(existsSync(tmp))unlinkSync(tmp);}
      const name=title.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').slice(0,80)+'-首图.png';
      db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(id,name,'image/png',bytes.length,at);
      db.prepare('INSERT INTO asset_dates VALUES(?,?)').run(id,archiveDay(at));
      return id;
    },
    makeVideo:async(targetId,artifact,aspect,signal,profileId)=>{
      const result=await generateVideo(targetId,artifact,aspect,signal,profileId);
      return {...result,...await inspectGeneratedVideo(result.video,signal)};
    },
    storeVideo:(targetId,title,bytes)=>{
      if(!Buffer.isBuffer(bytes)||bytes.toString('ascii',4,8)!=='ftyp')throw Error('invalid_video_output');
      const id='video-'+targetId,path=join(dataDir,'assets',id),tmp=path+'.'+randomUUID()+'.tmp',at=clock();
      try{writeFileSync(tmp,bytes,{flag:'wx'});renameSync(tmp,path);}finally{if(existsSync(tmp))unlinkSync(tmp);}
      db.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(id,title.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').slice(0,80)+'.mp4','video/mp4',bytes.length,at);
      db.prepare('INSERT INTO asset_dates VALUES(?,?)').run(id,archiveDay(at));
      return id;
    },
    supportsTarget:(account,type)=>{
      if (!adapter.rule) return true;
      try {const rule=adapter.rule(account,{type});return !!(rule.flow || (rule.submit && rule.success));}
      catch {return false;}
    },
    accountAvailable:id=>!deletingAccounts.has(id) && !!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(id)});
  const publicationAction=publicationActions({db,clock,getIntent,getJob,event,
    hasModel:modelReady,hasVerifier:platform=>!!verifier||readers.has(platform),
    canRecover:()=>typeof runtime.observeRecovery==='function',interrupt:id=>recovery.interrupt(id)});
  const agentTools=workflowTools({macros,publicationAction,getIntent,context:()=>({
    accounts:db.prepare('SELECT id,platform,name,mode,status FROM accounts').all(),
    assets:db.prepare("SELECT a.id,a.name,a.mime,a.size,d.day AS archiveDate,COALESCE(n.note,'') AS note FROM assets a LEFT JOIN asset_dates d ON d.asset_id=a.id LEFT JOIN asset_notes n ON n.asset_id=a.id").all(),creatorReaders:readerStatus,
    modelProfiles:models.view().profiles,models:{recovery:modelReady(),vision:model?.visionAvailable===true,writer:writerReady(),video:videoReady()},videoProfiles:videoModels.view().profiles
  })});
  const macroTimer=setInterval(()=>macros.tick().catch(()=>console.error('任务调度未完成')),tickMs);
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
        if (db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','waiting_human','recovering','awaiting_confirmation','needs_verification')").get(accountId)) continue;
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
      modelSettings:models.view(),imageSettings:images.view(),videoSettings:videoModels.view(),capabilities: { accountDeletion: true,creatorReaders:readerStatus },macroTemplates:macros.templates(),macroRuns:macros.runs(),
      platforms,
      accounts: db.prepare('SELECT * FROM accounts ORDER BY created').all(),
      assets: db.prepare("SELECT a.*,d.day AS archiveDate,COALESCE(n.note,'') AS note FROM assets a LEFT JOIN asset_dates d ON a.id=d.asset_id LEFT JOIN asset_notes n ON n.asset_id=a.id ORDER BY d.day DESC,a.created DESC,a.rowid DESC").all().map(a=>({...a,source:(()=>{const r=db.prepare('SELECT source FROM asset_sources WHERE asset_id=?').get(a.id);return r?JSON.parse(r.source):null;})()})),
      drafts: db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all().map(d => ({ ...JSON.parse(d.data), id: d.id, updated: d.updated })),
      jobs: db.prepare('SELECT j.*,d.snapshot,(SELECT COUNT(*) FROM publication_attempts a WHERE a.job_id=j.id) AS usedAttempts FROM jobs j JOIN dispatches d ON d.id=j.dispatch_id ORDER BY j.rowid DESC').all().map(j => ({  ...j, publicationIntent: getIntent(j.id), content: JSON.parse(j.snapshot), receipt: j.receipt ? JSON.parse(j.receipt) : null, events: db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY id').all(j.id) })),
    };
  }
  function getIntent(id) {
    const row = db.prepare('SELECT * FROM publication_intents WHERE job_id=?').get(id);
    if (!row) return null;
    const {policy_snapshot,...intent} = row;
    const lastObservation = db.prepare('SELECT checked_at,result,external_id FROM verification_observations WHERE job_id=? ORDER BY id DESC LIMIT 1').get(id);
    const attempts = db.prepare(`SELECT a.ordinal,a.invoked_at,r.receipt FROM publication_attempts a
      LEFT JOIN attempt_receipts r USING(job_id,ordinal) WHERE a.job_id=? ORDER BY a.ordinal`).all(id)
      .map(a=>({...a,receipt:a.receipt ? JSON.parse(a.receipt) : null}));
    const job=getJob(id);
    const owner=intent.status==='stopped'?'none':intent.status==='requires_human'||['waiting_human','awaiting_confirmation','needs_verification'].includes(job.state)?'human':
      job.state==='recovering'?'agent':intent.status==='checking'?'verifier':['uploading','submitting','opening_settings'].includes(job.state)?'script':'none';
    return {...intent,owner,attempts,recovery:db.prepare('SELECT stage,deadline,call_limit,calls,visual_calls,recovery_level,rounds,reason,reserved_micros,max_micros FROM recovery_incidents WHERE job_id=?').get(id) ?? null,policy:JSON.parse(policy_snapshot),lastObservation:lastObservation ?? null};
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
    beginSubmission(job.id,publicationOf(JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot)).mode==='auto'?'演示：按所选方式自动提交。':'用户确认演示提交。');
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
    const active=()=>!closed&&getIntent(job.id)?.status!=='stopped'&&!['cancelled','manually_closed'].includes(getJob(job.id)?.state);
    try {
      const reader=readers.get(account.platform);
      if (!verifier && reader && getIntent(job.id).policy.verification.enabled) {
        try {
          const baseline = await reader.baseline(account);
          db.prepare('INSERT OR REPLACE INTO verification_baselines VALUES(?,?)').run(job.id,JSON.stringify(baseline));
        } catch { /* A missing baseline keeps post-submit results inconclusive. */ }
      }
      const receipt=await adapter.submit(account,content,()=>{beginSubmission(job.id,automatic?'按任务中用户选择的“工具直接发布”执行最终提交。':'用户确认真实提交；禁止自动重发。');clicked=true;},{isActive:active,onProgress:message=>{step=message;if(!closed&&(clicked||active()))event(job.id,clicked?'submitting':'uploading',message);}});
      if(closed)return;
      db.prepare('UPDATE jobs SET receipt=? WHERE id=?').run(JSON.stringify(receipt),job.id);
      event(job.id,'submitted','平台页面出现提交成功标志；尚未核验审核与公开状态。');
    }catch(e){if(!closed){
      if(!clicked&&(e.code==='operation_cancelled'||!active()))return;
      if(clicked&&e.state==='needs_verification'){
        event(job.id,'needs_verification',e.message);
        try{await runtime.reveal(account,e.verificationPage);}catch(revealError){event(job.id,'needs_verification',revealError.message);}
      }else event(job.id,clicked?'unknown':(e.state||'needs_manual'),clicked?`提交结果待确认：${e.message} ${getIntent(job.id)?.next_check_at ? '任务将按保存策略核对稿件。' : '请人工检查稿件，禁止自动重发。'}`:(e.state?e.message:`${step}未完成${e.name==='TimeoutError'?'（等待超时）':''}，请在官方后台核对。`));
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
  async function verifyContext(context) {
    if (verifier) return verifier(context);
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(context.accountId);
    const reader=readers.get(account?.platform);
    if (!reader || account.mode==='demo') return {result:'unsupported_verifier'};
    const stored = db.prepare('SELECT snapshot FROM verification_baselines WHERE job_id=?').get(context.jobId);
    const receipts=db.prepare('SELECT receipt FROM attempt_receipts WHERE job_id=? ORDER BY ordinal').all(context.jobId);
    const receiptIds=receipts.flatMap(({receipt})=>{
      const r=JSON.parse(receipt);
      const id=workId(account.platform,r?.url);
      return r?.simulated===false && id && id===r.id ? [id] : [];
    });
    return reader.verify({...context,account,receiptIds,baseline:stored && JSON.parse(stored.snapshot)});
  }

  async function resend(row,version) {
    let release = await lockBrowser();
    let invoked = false;
    const current = () => !closed && getIntent(row.job_id)?.version === version;
    const finish = (status,next=null) => db.prepare('UPDATE publication_intents SET status=?,next_check_at=?,version=version+1 WHERE job_id=? AND version=?')
      .run(status,next,row.job_id,version);
    try {
      if (!current()) return;
      const job = getJob(row.job_id);
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
      const content = JSON.parse(row.snapshot);
      if (job.mode==='demo' || publicationOf(content).mode!=='auto' || account?.status!=='connected' ||
          account.platform_id !== row.platform_id) { finish('requires_human'); return; }
      if (db.prepare("SELECT 1 FROM jobs WHERE account_id=? AND id<>? AND state IN ('uploading','submitting','opening_settings','waiting_human','recovering','awaiting_confirmation','needs_verification','unknown')").get(account.id,job.id)) {
        finish('requires_human'); return;
      }
      const attempts = attemptsFor(db,job.id);
      if (validate(content,[account.id]).length) { finish('requires_human'); return; }
      // Keep the original submission tab for inspection. The verifier owns its own tab.
      await runtime.newSubmissionPage?.(account);
      if (!current()) return;
      let opening=false;
      const hooks={isActive:current,onOpening:()=>{opening=true;},onOpened:()=>{opening=false;}};
      try {await adapter.prepare(account,content,hooks);}
      catch (error) {
        const policy=publicationPolicy(JSON.parse(row.policy_snapshot)).recovery;
        if (!current() || !policy.enabled || typeof runtime.observeRecovery!=='function' ||
            (error.state && error.state!=='needs_manual') || opening) throw error;
        release();
        const ready=await recovery.run(job,account,null,policy,{
          stage:'resend_prepare',active:current,report:(state,message)=>logRecovery(job,message)
        });
        release=await lockBrowser();
        if (!ready || !current()) throw Error('resend_prepare_blocked');
        await adapter.prepare(account,content,{resumeRecovery:true,isActive:current});
      }
      if (!current()) return;
      const receipt = await adapter.submit(account,content,async () => {
        if (!current()) throw Error('stale_version');
        const started = Date.parse(clock());
        let observed;
        try {
          observed = await verifyContext({jobId:job.id,accountId:account.id,platform:account.platform,
            expectedIdentity:row.platform_id,content,attempts,runtime,checkStartedAt:started});
        } catch(error) {
          if (['needs_login','identity_mismatch','needs_verification'].includes(error.state)) throw error;
          observed={result:'inconclusive'};
        }
        if (!current()) throw Error('stale_version');
        const checkedAt = clock();
        const evidence = observed?.result==='absent_valid' && absenceEvidence(observed,attempts,row.platform_id,Date.parse(checkedAt),started);
        const policy = JSON.parse(row.policy_snapshot);
        if (!evidence || Date.parse(checkedAt)-started > policy.verification.lastCheckFreshnessSeconds*1000) {
          const verified = observed?.accountIdentity?.verified===true && observed.accountIdentity.observed===account.platform_id;
          const known = ['found_published','found_reviewing','found_scheduled','found_draft','found_rejected','duplicate_suspected','ambiguous'];
          const result = verified && known.includes(observed.result) ? observed.result : 'inconclusive';
          const repeat = ['found_reviewing','found_scheduled','ambiguous','inconclusive'].includes(result);
          const interval = JSON.parse(row.policy_snapshot).verification.checkIntervalSeconds;
          db.exec('BEGIN IMMEDIATE');
          try {
            finish(result,repeat ? new Date(Date.parse(checkedAt)+interval*1000).toISOString() : null);
            db.prepare('INSERT INTO verification_observations(job_id,checked_at,result) VALUES(?,?,?)').run(job.id,checkedAt,result);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          throw Error('final_check_blocked');
        }
        db.prepare('INSERT INTO verification_observations(job_id,checked_at,result,evidence) VALUES(?,?,?,?)')
          .run(job.id,checkedAt,'absent_valid',JSON.stringify(evidence));
        beginSubmission(job.id,'已完成提交前最后查重，按任务快照执行有限重发。',version);
        invoked = true;
      },{isActive:current});
      if (!closed && invoked) {
        db.prepare('UPDATE jobs SET receipt=? WHERE id=?').run(JSON.stringify(receipt),job.id);
        event(job.id,'submitted','重发后原页出现提交回执，等待创作中心核对。');
      }
    } catch(error) {
      if (!closed && invoked) {
        event(row.job_id,error.state==='needs_verification'?'needs_verification':'unknown','重发已占用名额，等待核对或本人验证。');
        if (error.state==='needs_verification') await runtime.reveal?.(db.prepare('SELECT * FROM accounts WHERE id=?').get(row.account_id),error.verificationPage);
      } else if (current()) finish('requires_human');
    } finally { release(); }
  }
  function logRecovery(job,message) {
    db.prepare('INSERT INTO events(job_id,state,message,created) VALUES(?,?,?,?)')
      .run(job.id,job.state,message,clock());
  }
  async function verifiedRead(context,active) {
    const release=await lockBrowser();
    try {
      if (!active()) return {result:'inconclusive'};
      return await verifyContext(context);
    } finally {release();}
  }
  async function verifyWithRecovery(context) {
    const active=()=>!closed && !!db.prepare(`SELECT 1 FROM publication_intents
      WHERE job_id=? AND version=? AND status='checking' AND deadline_at>? AND next_check_at>?`)
      .get(context.jobId,context.version,clock(),clock());
    try {return await verifiedRead(context,active);}
    catch (error) {
      if (!active()) return {result:'inconclusive'};
      if (['needs_login','identity_mismatch','needs_verification'].includes(error.state)) return {result:'requires_human'};
      const source=error.recoveryPage;
      const policy=publicationPolicy(getIntent(context.jobId).policy).recovery;
      if (!source || !policy.enabled) return {result:'inconclusive'};
      const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(context.accountId);
      const job=getJob(context.jobId);
      const report=(state,message)=>{
        if (active()) logRecovery(job,message);
      };
      const recovered=await recovery.run(job,account,null,policy,{...source,active,report,stage:'verification'});
      if (!active()) return {result:'inconclusive'};
      if (!recovered) return {result:'requires_human'};
      return verifiedRead(context,active);
    }
  }
  const monitorTick = publicationMonitor({db,clock,runtime,resend,isClosed:()=>closed,
    verifier:(verifier || readers.size) && verifyWithRecovery
  });
  const creatorMonitor = setInterval(() => {
    if (!browserBusy) monitorTick().catch(() => console.error('创作中心核对任务未完成'));
  },tickMs);
  const worker = setInterval(async () => {
    if (closed || browserBusy || authChecks.size) return;
    if (db.prepare("SELECT id FROM jobs WHERE state IN ('uploading','submitting') LIMIT 1").get()) return;
    const job = db.prepare("SELECT * FROM jobs j WHERE state='queued' AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.account_id=j.account_id AND (a.state IN ('waiting_human','recovering','awaiting_confirmation','needs_verification','unknown','needs_login','identity_mismatch') OR EXISTS(SELECT 1 FROM publication_intents i WHERE i.job_id=a.id AND i.status='retry_ready'))) ORDER BY rowid LIMIT 1").get();
    if (!job) return;
    if (job.mode !== 'demo') {
      const release=await lockBrowser();
      event(job.id, 'uploading', '开始真实页面准备：检查身份、上传素材并填写。');
      let preparing=false;
      let recoveryAccount, recoveryEditor;
      let step='切换账号执行环境';
      const active=()=>!closed&&getIntent(job.id)?.status!=='stopped'&&['uploading','opening_settings'].includes(getJob(job.id)?.state);
      const progress=message=>{step=message;if(active())event(job.id,'uploading',message);};
      try {
        let account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
        const content = JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
        activeTasks.set(account.id,job.id);
        event(job.id,'uploading',publicationOf(content).silent?((model || job.platform==='douyin')?'后台最小化执行；出现验证时显示原窗口，等待你完成。':'自动发布使用无界面浏览器，遇到验证请从任务打开可见后台。'):'发布使用可见浏览器。');
        if(account.status==='disconnected')throw Object.assign(fail('账号连接已停用，请重新登录后重试',409),{state:'needs_login'});
        progress('切换账号执行环境');
        await runtime.setMode?.(account,publicationOf(content).silent,{restore:false});
        progress('同步账号身份');
        await syncIdentity(account);
        account=db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id);
        preparing=true;
        recoveryAccount=account;
        const rule = adapter.rule?.(account,content);
        if (rule?.title && rule.url) {
          const editorUrl=new URL(rule.url);
          recoveryEditor={platform:account.platform,selector:rule.title,url:editorUrl.origin+editorUrl.pathname,title:content.versions?.[account.platform]?.title || content.title};
        }
        const prepared=await adapter.prepare(account, content,{isActive:active,resumeRecovery:getIntent(job.id)?.recovery?.recovery_level==='visual'&&getIntent(job.id)?.recovery?.reason==='revalidate',onProgress:progress,onOpening:()=>{if(!active())throw Object.assign(Error('任务已停止'),{code:'operation_cancelled'});event(job.id,'opening_settings','按语义定位打开知乎发布入口，等待确认设置面板；未确认前禁止重发。');},onOpened:()=>{if(active())event(job.id,'uploading','已确认知乎发布设置面板打开，尚未进行最终提交。');}});
        preparing=false;
        if(!active())return;
        if (!closed) {
          if(prepared?.aiDisclosure)event(job.id,'uploading',prepared.aiDisclosure.evidence||(prepared.aiDisclosure.state==='pending'?'AI声明尚未匹配，最终提交前必须确认所选状态。':`AI声明处理：${prepared.aiDisclosure.checked===null?'沿用旧任务状态':prepared.aiDisclosure.checked?'勾选':'不勾选'}。`));
          if(publicationOf(content).mode==='auto')await submitReal(job,account,content,true);
          else event(job.id, 'awaiting_confirmation', '按所选方式暂停，等待人工处理封面、分区和声明，完成后确认提交。');
        }
      } catch (e) {
        if(e.code==='operation_cancelled'||!active())return;
        if (!closed && preparing && e.state==='needs_verification' && !attemptsFor(db,job.id).length) {
          event(job.id,'waiting_human','请在原页面完成本人验证，再恢复准备。');
          try { await runtime.reveal?.(recoveryAccount,e.verificationPage); }
          catch { event(job.id,'needs_manual','原页面无法显示，请从任务详情打开可见浏览器后处理。'); }
          return;
        }
        if (!closed && preparing && getIntent(job.id).policy.recovery?.enabled!==false && typeof runtime.observeRecovery==='function' && getJob(job.id).state==='uploading' &&
            (!e.state || e.state==='needs_manual') && !attemptsFor(db,job.id).length) {
          if(recoveryEditor){recoveryEditor.failureCode=e.code==='image_upload_failed'?'image_upload_failed':null;const snapshot=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);recoveryEditor.coordinateGoal=preparationGoal(snapshot,job.platform,step,e.code);}
          event(job.id,'recovering',e.state==='needs_manual'?`准备失败：${e.message} 正在观察原账号页面。`:`${step}未完成，正在观察原账号页面。`);
          release();
          await recovery.run(job,recoveryAccount,recoveryEditor,publicationPolicy(getIntent(job.id).policy).recovery);
          return;
        }
        if (!closed) event(job.id, e.state==='detecting'?'needs_manual':e.state || 'needs_manual', e.state ? e.message : `${step}未完成${e.name==='TimeoutError'?'（等待超时）':''}，请打开任务浏览器检查。`); }
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
            db.prepare('INSERT INTO asset_notes VALUES(?,?)').run(assetId,'');
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
        if(req.method==='GET' && url.pathname==='/api/agent/tools')return send(200,agentTools.list());
        if(req.method==='POST' && url.pathname==='/api/agent/actions') {
          const value=agentTools.execute(body.name,body.arguments);
          return send(200,{ok:true,result:value});
        }
        const publicationRead=url.pathname.match(/^\/api\/publications\/([\w-]+)$/);
        if(req.method==='GET' && publicationRead) {
          const value=getIntent(publicationRead[1]);
          if(!value)throw fail('发布任务不存在',404);
          return send(200,value);
        }
        const publicationCommand=url.pathname.match(/^\/api\/publications\/([\w-]+)\/(verify|recover|request-retry|human-completed|stop)$/);
        if(req.method==='POST' && publicationCommand) {
          const result=publicationAction(publicationCommand[1],publicationCommand[2],body);
          return send(200,{...result.publication,reasonCode:result.reasonCode});
        }
        if(url.pathname==='/api/image-settings'){if(req.method==='GET')return send(200,images.view());if(req.method==='POST')return send(200,images.save(body));}
        if(req.method==='POST'&&url.pathname==='/api/video-settings/select')return send(200,videoModels.select(body.id));
        if(req.method==='POST'&&url.pathname==='/api/video-settings/check')return send(200,videoModels.check(body.id));
        if(url.pathname==='/api/video-settings'){if(req.method==='GET')return send(200,videoModels.view());if(req.method==='POST')return send(200,videoModels.save(body));}
        if(req.method==='POST'&&url.pathname==='/api/model-settings/select')return send(200,models.select(body.id));
        if(req.method==='POST'&&url.pathname==='/api/model-settings/test')return send(200,await models.test(body.id));
        if(url.pathname==='/api/model-settings') {
          if(req.method==='GET')return send(200,models.view());
          if(req.method==='POST')return send(200,models.save(body));
        }
        if(url.pathname==='/api/task-templates') {
          if(req.method==='GET') return send(200,macros.templates());
          if(req.method==='POST') return send(201,macros.save(body));
        }
        const templateRoute=url.pathname.match(/^\/api\/task-templates\/([\w-]+)(\/(?:run|delete))?$/);
        if(req.method==='DELETE'&&templateRoute&&!templateRoute[2])return send(200,macros.remove(templateRoute[1],Number(url.searchParams.get('expectedVersion'))));
        if(req.method==='POST' && templateRoute) {
          if(templateRoute[2]==='/delete')return send(200,macros.remove(templateRoute[1],body.expectedVersion));
          if(!templateRoute[2]) return send(200,macros.save(body,templateRoute[1],true));
          const run=macros.runNow(templateRoute[1],body.requestKey);
          return send(run.reused?200:201,run);
        }
        if(req.method==='GET' && url.pathname==='/api/runs') return send(200,macros.runs());
        const stopRun=url.pathname.match(/^\/api\/runs\/([\w-]+)\/stop$/);
        if(req.method==='POST' && stopRun) return send(200,macros.stopRun(stopRun[1]));
        const editorialRoute=url.pathname.match(/^\/api\/runs\/([\w-]+)\/targets\/([\w-]+)\/(edit|revise|approve)$/);
        if(req.method==='POST'&&editorialRoute)return send(200,macros.reviewTarget(editorialRoute[1],editorialRoute[2],body,editorialRoute[3]));
        const resumeTarget=url.pathname.match(/^\/api\/runs\/([\w-]+)\/targets\/([\w-]+)\/resume$/);
        if(req.method==='POST' && resumeTarget) return send(200,macros.resumeTarget(resumeTarget[1],resumeTarget[2]));
        const runRoute=url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
        if(req.method==='GET' && runRoute) return send(200,macros.details(runRoute[1]));
        const textRoute=url.pathname.match(/^\/api\/assets\/([\w-]+)\/(text|ocr)$/);
        if(textRoute) {
          const [,id,action]=textRoute;
          imageText.assertImage(id);
          if(action==='text' && req.method==='GET')return send(200,imageText.get(id));
          if(action==='text' && req.method==='POST')return send(200,imageText.save(id,body));
          if(action==='ocr' && req.method==='POST')return send(200,await imageText.analyze(id));
        }
        const assetAction = url.pathname.match(/^\/api\/assets\/([\w-]+)$/);
        if (assetAction && ['POST','DELETE'].includes(req.method)) {
          const assetId = assetAction[1];
          const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(assetId);
          if (!asset) throw fail('素材不存在', 404);
          if (req.method === 'DELETE') {
            if(imageText.busy(assetId))throw fail('图片正在本地识别，请稍后再删除',409);
            if(macros.referenced('asset',assetId)) throw fail('素材正被任务模板或待分发成品引用',409);
            const drafts = db.prepare('SELECT data FROM drafts').all().filter(d => referencesAsset(JSON.parse(d.data), assetId));
            const jobs = db.prepare("SELECT d.snapshot FROM jobs j JOIN dispatches d ON d.id=j.dispatch_id WHERE j.state NOT IN ('submitted','demo_submitted','cancelled','manually_closed') OR EXISTS(SELECT 1 FROM publication_intents i WHERE i.job_id=j.id AND (i.next_check_at IS NOT NULL OR i.status='requires_human'))").all().filter(j => referencesAsset(JSON.parse(j.snapshot), assetId));
            if (drafts.length || jobs.length) throw fail('素材被 '+drafts.length+' 份草稿、'+jobs.length+' 个未结束任务引用，请先在草稿中移除素材或结束相关任务后再删除', 409);
            const file = join(dataDir, 'assets', assetId);
            const cacheRoot = resolve(dataDir, 'assets', '.browser-upload');
            const cache = resolve(cacheRoot, assetId);
            if (dirname(cache) !== cacheRoot) throw fail('素材缓存路径无效');
            rmSync(cache, { recursive: true, force: true });
            if (existsSync(file)) unlinkSync(file);
            db.prepare('DELETE FROM asset_sources WHERE asset_id=?').run(assetId);
            db.prepare('DELETE FROM asset_notes WHERE asset_id=?').run(assetId);
            db.prepare('DELETE FROM asset_dates WHERE asset_id=?').run(assetId);
            db.prepare('DELETE FROM asset_text WHERE asset_id=?').run(assetId);
            db.prepare('DELETE FROM assets WHERE id=?').run(assetId);
            return send(200, { deleted: assetId });
          }
          const name = body.name === undefined ? asset.name : body.name;
          if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\\/\x00-\x1f]/.test(name)) throw fail('素材名称须为1–240个字符，不能包含路径或控制字符');
          if (extname(name.trim()).toLowerCase() !== extname(asset.name).toLowerCase()) throw fail('请保留原文件扩展名');
          const day = body.archiveDate === undefined ? (db.prepare('SELECT day FROM asset_dates WHERE asset_id=?').get(assetId)?.day || archiveDay(asset.created)) : body.archiveDate;
          if (!validArchiveDay(day)) throw fail('归档日期无效，请使用有效的 YYYY-MM-DD 日期');
          const note=body.note===undefined?(db.prepare('SELECT note FROM asset_notes WHERE asset_id=?').get(assetId)?.note||''):body.note;
          if(typeof note!=='string'||note.length>2000)throw fail('用户备注不能超过2000字');
          db.prepare('INSERT INTO asset_notes VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET note=excluded.note').run(assetId,note.trim());
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
            if(macros.referenced('account',accountId)) throw fail('该账号正被任务模板或待分发成品引用',409);
            const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE account_id=? AND (state NOT IN ('submitted','demo_submitted','cancelled','manually_closed') OR EXISTS(SELECT 1 FROM publication_intents i WHERE i.job_id=jobs.id AND (i.next_check_at IS NOT NULL OR i.status='requires_human')))").get(accountId).n;
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
            if (accountMatch[2] !== 'open' && db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','opening_settings','waiting_human','recovering','awaiting_confirmation','needs_verification','unknown')").get(account.id)) throw fail('账号有待处理发布任务，请先核对或取消任务', 409);
            if (accountMatch[2] === 'open') {
              if (db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting')").get(account.id)) throw fail('账号正在发布准备，请稍后打开',409);
              if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('waiting_human','recovering','awaiting_confirmation','needs_verification','unknown')").get(account.id))throw fail('请从待处理任务点击“打开任务浏览器”进行接管',409);
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
          const result = dispatch(body);
          return send(result.status, result.body);
        }
        const history=url.pathname.match(/^\/api\/publications\/([\w-]+)\/observations$/);
        if(req.method==='GET' && history) {
          if(!db.prepare('SELECT 1 FROM publication_intents WHERE job_id=?').get(history[1]))throw fail('发布任务不存在',404);
          const cursor=url.searchParams.has('before')?Number(url.searchParams.get('before')):Number.MAX_SAFE_INTEGER;
          if(!Number.isSafeInteger(cursor)||cursor<1)throw fail('无效的核对记录游标');
          const rows=db.prepare('SELECT id,checked_at,result,external_id,evidence FROM verification_observations WHERE job_id=? AND id<? ORDER BY id DESC LIMIT 26').all(history[1],cursor);
          const entries=rows.slice(0,25).map(({evidence,...row})=>{
            const proof=JSON.parse(evidence||'null');
            return {...row,ordinal:proof?.ordinal??null,accountVerified:proof?.accountIdentity?.verified===true,coverage:proof?.coverage??null};
          });
          return send(200,{entries,nextBefore:rows.length>25?entries.at(-1).id:null});
        }
        const showVerifier=url.pathname.match(/^\/api\/publications\/([\w-]+)\/open-verifier$/);
        if (req.method==='POST' && showVerifier) {
          const release=await lockBrowser();
          try {
            const intent=getIntent(showVerifier[1]);
            if (!intent || intent.status!=='requires_human' || intent.version!==body.expectedVersion) throw fail('核对任务状态已更新',409);
            const job=getJob(showVerifier[1]);
            const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
            const reader=readers.get(account?.platform);
            if (!reader || account.mode==='demo') throw fail('该通道没有可显示的管理页',409);
            await reader.reveal(account);
            return send(200,{ok:true});
          } finally {release();}
        }
        const match = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/(confirm|cancel|resume|resolve|inspect|retry|check-result|human-completed)$/);
        if (req.method === 'POST' && match) {
          const job = getJob(match[1]); const action = match[2];
          if(action==='human-completed'){
            if(job.state!=='waiting_human' || attemptsFor(db,job.id).length) throw fail('任务当前不可恢复准备',409);
            event(job.id,'queued','本人处理完成，将重新核验账号与页面，再执行标准准备。');
            return send(200,{ok:true});
          }
          if(action==='check-result'){
            if(job.platform!=='douyin'||!['needs_verification','unknown'].includes(job.state)||!db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id))throw fail('只能核对抖音已尝试提交的原任务结果',409);
            if(browserBusy)throw fail('执行器正忙，请稍后核对',409);const release=await lockBrowser();try{return send(200,await checkVerificationResult(job));}finally{release();}
          }
          if(action==='retry'){
            const snapshot=JSON.parse(db.prepare('SELECT snapshot FROM dispatches WHERE id=?').get(job.dispatch_id).snapshot);
            const canResumeAuto=job.state==='awaiting_confirmation' && publicationOf(snapshot).mode==='auto';
            if((!['needs_manual','needs_login'].includes(job.state)&&!canResumeAuto) || db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id))throw fail('只可重试尚未提交的失败任务；提交结果未知时禁止重发',409);
            if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND state IN ('uploading','submitting','opening_settings','waiting_human','recovering','awaiting_confirmation','needs_verification','unknown') AND id<>?").get(job.account_id,job.id))throw fail('同账号还有待处理任务，请先核对',409);
            event(job.id,'queued','用户重试未提交任务，保留原内容和发布选项；准备流程将重新执行。');return send(200,{ok:true});
          }
          if (action === 'inspect') {
            if (job.mode === 'demo') throw fail('演示任务没有真实浏览器');
            if (browserBusy) throw fail('浏览器正在执行操作，请稍后', 409);
            if(db.prepare("SELECT id FROM jobs WHERE account_id=? AND id<>? AND state IN ('uploading','submitting','opening_settings','waiting_human','recovering','awaiting_confirmation','needs_verification','unknown')").get(job.account_id,job.id))throw fail('同账号还有其他待处理或结果未知的任务，请先处理该任务，避免覆盖其发布页面',409);
            const release=await lockBrowser();
            const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(job.account_id);
            try {
              if (!account) throw fail('该任务的账号已删除，历史记录仅供查看', 409);
              const attempted=db.prepare("SELECT id FROM events WHERE job_id=? AND state='submitting'").get(job.id);
              if (['recovering','waiting_human'].includes(job.state)) {
                if (job.state==='recovering') {
                  recovery.interrupt(job.id);
                  db.prepare("UPDATE recovery_incidents SET reason='needs_human' WHERE job_id=?").run(job.id);
                  event(job.id,'waiting_human','用户接管原页面，已撤销恢复动作。');
                }
                try { await runtime.reveal(account); }
                catch {
                  if (attempted) throw fail('提交后原页面无法显示，请到创作中心核对',409);
                  await runtime.setMode?.(account,false,{restore:true});
                  await runtime.open(account,false,true);
                  event(job.id,'waiting_human','原页面无法显示，已打开账号后台。处理后将重新检查任务。');
                }
                return send(200,{ok:true});
              }
              if(attempted){
                db.prepare("UPDATE publication_intents SET status='stopped',next_check_at=NULL,version=version+1 WHERE job_id=? AND next_check_at IS NOT NULL").run(job.id);
                recovery.interrupt(job.id);
                await runtime.reveal(account);return send(200,{ok:true});}
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
            if (!['queued', 'uploading', 'waiting_human', 'awaiting_confirmation', 'needs_login','needs_manual','identity_mismatch'].includes(job.state)) throw fail('提交后不可取消或重发，请核对结果', 409);
            event(job.id, 'cancelled', '用户取消了提交前任务。');
          } else if (action === 'resume') {
            if (job.state !== 'needs_login' || job.mode !== 'demo') throw fail('任务不可恢复', 409);
            db.prepare("UPDATE jobs SET scenario='normal' WHERE id=?").run(job.id); event(job.id, 'queued', '演示会话已恢复，重新排队。');
          } else {
            if (!['unknown','needs_verification','needs_manual','identity_mismatch'].includes(job.state)) throw fail('任务当前无需人工核对', 409);
            db.prepare("UPDATE publication_intents SET status='stopped',next_check_at=NULL,version=version+1 WHERE job_id=? AND next_check_at IS NOT NULL").run(job.id);
            db.prepare("UPDATE publication_intents SET status='stopped',version=version+1 WHERE job_id=? AND status='requires_human'").run(job.id);
            recovery.interrupt(job.id);
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
      const files = { '/': 'index.html', '/app.js': 'app.js', '/macro.js':'macro.js', '/task-schedule.js':'task-schedule.js', '/video-config.js':'video-config.js', '/artifact-review.js':'artifact-review.js', '/image-config.js':'image-config.js', '/task-view.js':'task-view.js', '/model-config.js':'model-config.js', '/editor.bundle.js':'editor.bundle.js', '/style.css': 'style.css' }; const file = files[url.pathname];
      if (!file) throw fail('页面不存在', 404);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(readFileSync(join(root, 'public', file)));
    } catch (e) { if (!res.headersSent && !res.destroyed) send(e.status || 500, { reasonCode:e.reasonCode, error: e.status ? e.message : '本地服务出错，请检查服务终端' }); else if (!res.destroyed) res.end(); }
  });
  return {server,db,agentTools,close:async()=>{
    closed=true;
    for(const interval of [macroTimer,worker,creatorMonitor,loginMonitor,verificationMonitor]) clearInterval(interval);
    for(const timer of timers) clearTimeout(timer);
    macros.close();imageText.close();recovery.close();
    await new Promise(resolve=>server.close(resolve));
    const release=await lockBrowser();
    try {await runtime.close();} finally {release();db.close();}
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318); const studio = createStudio();
  studio.server.listen(port, '127.0.0.1', () => console.log(`Matrix Studio 本地预览：http://127.0.0.1:${port}\n演示账号仅模拟；真实账号会操作官方后台，最终提交需确认。`));
  studio.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可设置 PORT 后重启。` : e.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await studio.close(); process.exit(0); });
}
