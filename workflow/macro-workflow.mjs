import {reportContent} from './report-content.mjs';
import {normalizeSchedule,occurrence} from './task-schedule.mjs';
import {validArchiveDay} from '../asset-library.mjs';
import {randomUUID} from 'node:crypto';
import {publicationPolicy} from './publication-policy.mjs';
import {platforms} from '../platform-catalog.mjs';

const error=(message,status=422)=>Object.assign(Error(message),{status});
function integer(value,min,max,label) {
  if (!Number.isSafeInteger(value) || value<min || value>max) throw error('参数无效：'+label);
  return value;
}
function string(value,max,label) {
  if (typeof value!=='string' || !value.trim() || value.length>max) throw error('请填写有效的'+label);
  return value.trim();
}
function transaction(db,fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const value=fn();db.exec('COMMIT');return value;}
  catch(e) {db.exec('ROLLBACK');throw e;}
}
const iso=ms=>new Date(ms).toISOString();

export function macroWorkflow({db,clock,writer,videoProfileId=()=>null,imageText,makeCard,storeCard,makeVideo,storeVideo,publicationSummary,dispatch,isClosed,accountAvailable,supportsTarget,callMicros=0}) {
  integer(callMicros,0,1000000000,'生成模型单次预留费用');
  transaction(db,()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=10').get())return;
    db.exec(`CREATE TABLE IF NOT EXISTS task_templates(id TEXT PRIMARY KEY,version INTEGER NOT NULL,
    enabled INTEGER NOT NULL,spec TEXT NOT NULL,next_at TEXT);
    CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,template_version INTEGER NOT NULL,
    run_key TEXT NOT NULL,scheduled_for TEXT NOT NULL,snapshot TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,
    UNIQUE(template_id,run_key));
    CREATE TABLE IF NOT EXISTS workflow_targets(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,slot INTEGER NOT NULL,
    state TEXT NOT NULL,artifact TEXT,dispatch_id TEXT,reason TEXT,lease_until TEXT,UNIQUE(run_id,slot));
    CREATE INDEX IF NOT EXISTS workflow_pending ON workflow_targets(state,lease_until);
    CREATE INDEX IF NOT EXISTS workflow_template_due ON task_templates(enabled,next_at);`);
    db.exec('ALTER TABLE workflow_runs ADD COLUMN call_micros INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN reserved_micros INTEGER NOT NULL DEFAULT 0');
    db.prepare('INSERT INTO schema_migrations VALUES(10,?)').run(clock());
  });
  transaction(db,()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=11').get())return;
    db.exec(`CREATE TABLE asset_usage(target_id TEXT NOT NULL,account_id TEXT NOT NULL,asset_id TEXT NOT NULL,used_at TEXT NOT NULL,
      PRIMARY KEY(target_id,asset_id));
      CREATE INDEX asset_usage_account ON asset_usage(account_id,asset_id,used_at);`);
    db.prepare(`INSERT OR IGNORE INTO asset_usage SELECT t.id,json_extract(r.snapshot,'$.targets['||t.slot||'].accountId'),a.value,r.scheduled_for
      FROM workflow_targets t JOIN workflow_runs r ON r.id=t.run_id,json_each(t.artifact,'$.assetIds') a
      WHERE t.artifact IS NOT NULL AND t.state IN ('dispatched','ready')`).run();
    db.prepare('INSERT INTO schema_migrations VALUES(11,?)').run(clock());
  });
  transaction(db,()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=17').get())return;
    db.exec("ALTER TABLE workflow_targets ADD COLUMN draft TEXT; ALTER TABLE workflow_targets ADD COLUMN authorized_assets TEXT NOT NULL DEFAULT '[]'; ALTER TABLE workflow_targets ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; ALTER TABLE workflow_targets ADD COLUMN feedback TEXT; ALTER TABLE workflow_targets ADD COLUMN review_phase TEXT; CREATE TABLE workflow_artifact_versions(target_id TEXT NOT NULL,revision INTEGER NOT NULL,artifact TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(target_id,revision))");
    db.prepare('INSERT INTO schema_migrations VALUES(17,?)').run(clock());
  });
  transaction(db,()=>{
    if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=18').get())return;
    db.exec("ALTER TABLE workflow_targets ADD COLUMN research_sources TEXT NOT NULL DEFAULT '[]'; ALTER TABLE workflow_targets ADD COLUMN search_calls INTEGER NOT NULL DEFAULT 0");
    db.prepare('INSERT INTO schema_migrations VALUES(18,?)').run(clock());
  });
  const reviewState=(spec,artifact)=>spec.reviewBeforePublish&&artifact.type!=='video'?'awaiting_review':'ready';
  const record=(id,note)=>{const row=db.prepare('SELECT revision,artifact FROM workflow_targets WHERE id=?').get(id);db.prepare('INSERT INTO workflow_artifact_versions VALUES(?,?,?,?,?)').run(id,row.revision,row.artifact,note,clock());};
  function material(id){const asset=db.prepare('SELECT id,name,mime FROM assets WHERE id=?').get(id);if(!asset)return null;const source=db.prepare('SELECT source FROM asset_sources WHERE asset_id=?').get(id);return {...asset,note:db.prepare('SELECT note FROM asset_notes WHERE asset_id=?').get(id)?.note||'',...(source?{source:JSON.parse(source.source)}:{})};}
  function cooling(accountId,id,seconds,now) {
    if(!seconds)return false;
    return !!db.prepare(`SELECT 1 FROM asset_usage u JOIN workflow_targets t ON t.id=u.target_id
      WHERE u.account_id=? AND u.asset_id=? AND (t.state IN ('ready','card_pending','rendering','awaiting_review','revision_pending','revising') OR (t.state='dispatched' AND u.used_at>?)) LIMIT 1`)
      .get(accountId,id,iso(now-seconds*1000));
  }
  function normalize(input) {
    if (!input || typeof input!=='object') throw error('缺少任务参数');
    const taskMode=input.taskMode??'generate';
    if(!['generate','direct','select'].includes(taskMode))throw error('任务内容方式无效');
    const assetRange=input.assetRange??{};
    if(taskMode==='select'&&(!validArchiveDay(assetRange.from)||!validArchiveDay(assetRange.to)||assetRange.from>assetRange.to))throw error('请选择有效素材日期区间');
    if(taskMode==='select')input={...input,assetIds:[],assetNotes:{}};
    const topic=string(input.topic,500,'主题');
    const style=string(taskMode==='direct'?(input.style||'直接发布素材'):input.style,2000,'定位');
    const facts=input.facts===''?'':string(input.facts,16000,'事实资料');
    if(taskMode!=='select' && !facts && !input.assetIds?.length && !input.imageSearch?.enabled && !input.webResearch)throw error('请填写事实资料或选择素材');
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length>32) throw error('请选择 1–32 个账号目标');
    const slots=new Set();
    const targets=input.targets.map(t=>{
      const account=db.prepare('SELECT id,platform,mode FROM accounts WHERE id=?').get(String(t?.accountId));
      if (!account || !accountAvailable(t.accountId) || !['article','note','video'].includes(t.type) ||
          !platforms[account.platform]?.types.includes(t.type)) throw error('账号或稿件类型不可用');
      if(account.mode!=='demo' && !supportsTarget(account,t.type)) throw error('该账号的发布通道尚未完成提交配置');
      const slot=t.accountId+'/'+t.type;
      if(slots.has(slot)) throw error('重复的账号与稿件类型');
      slots.add(slot);
      return {accountId:t.accountId,platform:account.platform,type:t.type,style:t.style?string(t.style,2000,'账号定位'):''};
    });
    if(!Array.isArray(input.assetIds) || input.assetIds.length>100) throw error('素材范围无效');
    const assetIds=[...new Set(input.assetIds)];
    for (const id of assetIds) {
      if (typeof id!=='string'|| !db.prepare("SELECT 1 FROM assets WHERE id=? AND (mime LIKE 'image/%' OR mime LIKE 'video/%')").get(id)) throw error('素材范围含无效图片或视频');
    }
    if(input.sourceMode!=null&&!['description','content'].includes(input.sourceMode))throw error('素材理解方式无效');
    if(input.sourceMode==='content'&&assetIds.length>8)throw error('读取素材内容时每次最多选择 8 份素材');
    if(input.generationModelId!=null&&(typeof input.generationModelId!=='string'||!input.generationModelId||input.generationModelId.length>100))throw error('写作模型配置无效');
    if(input.videoModelId!=null&&(typeof input.videoModelId!=='string'||!input.videoModelId||input.videoModelId.length>100))throw error('视频模型配置无效');
    const assetNotes={};
    if(input.assetNotes!=null) {
      if(!input.assetNotes || typeof input.assetNotes!=='object' || Array.isArray(input.assetNotes)) throw error('素材描述无效');
      for(const [id,note] of Object.entries(input.assetNotes)) {
        if(!assetIds.includes(id)) throw error('素材描述超出范围');
        assetNotes[id]=string(note,500,'素材描述');
      }
    }
    if(!['auto','manual'].includes(input.mode)) throw error('请指定发布方式');
    if(input.douyinVisibility!=null && !['public','private'].includes(input.douyinVisibility))throw error('抖音可见范围无效');
    for(const flag of ['editorialReview','reviewBeforePublish','webResearch'])if(input[flag]!==undefined&&typeof input[flag]!=='boolean')throw error('审稿选项无效');
    const search=input.imageSearch??{};
    if(typeof search!=='object'||Array.isArray(search)||['enabled','useReferenceImages'].some(k=>search[k]!==undefined&&typeof search[k]!=='boolean'))throw error('配图检索选项无效');
    const imageSearch={enabled:taskMode==='generate'&&search.enabled===true,useReferenceImages:search.useReferenceImages!==false,maxImages:integer(search.maxImages??3,1,4,'检索图片数量')};
    const schedule=normalizeSchedule(input.schedule);
    if(taskMode!=='direct' && input.maxMicros!=null && !callMicros) throw error('金额预算需要配置生成模型单次预留费用');
    if(input.useImageText!==undefined && typeof input.useImageText!=='boolean')throw error('图片文字选项无效');
    if(input.noteCard!==undefined && typeof input.noteCard!=='boolean')throw error('图文首图选项无效');
    if(input.videoAspect!==undefined && !['portrait','landscape'].includes(input.videoAspect))throw error('视频比例无效');
    if(taskMode==='direct' && !assetIds.length)throw error('直接发布请选择素材');
    if(taskMode==='direct' && targets.some(t=>!assetIds.some(id=>db.prepare('SELECT mime FROM assets WHERE id=?').get(id).mime.startsWith(t.type==='video'?'video/':'image/'))))throw error('视频目标请选择视频，文章与图文目标请选择图片');
    return {douyinVisibility:input.douyinVisibility??null,webResearch:taskMode==='generate'&&input.webResearch===true,maxSearchRequests:integer(input.maxSearchRequests??4,1,8,'检索请求次数上限'),editorialReview:input.editorialReview!==false,reviewBeforePublish:input.reviewBeforePublish===true,imageSearch,videoModelId:input.videoModelId||null,taskMode,assetRange:taskMode==='select'?{from:assetRange.from,to:assetRange.to}:null,topic,style,facts,targets,assetIds,sourceMode:input.sourceMode||'description',generationModelId:input.generationModelId||null,assetNotes,videoAspect:input.videoAspect||'portrait',noteCard:input.noteCard===true,useImageText:input.useImageText===true,mode:input.mode,publicationPolicy:publicationPolicy(input.publicationPolicy),
      assetCooldownSeconds:integer(input.assetCooldownSeconds??0,0,31536000,'素材冷却时间'),
      maxMicros:input.maxMicros==null?null:integer(input.maxMicros,0,1000000000,'每次运行费用上限'),
      maxCalls:integer(input.maxCalls??Math.min(32,targets.reduce((n,t)=>n+(input.generationModelId?(input.editorialReview!==false&&t.type!=='video'?3:2):1)+((imageSearch.enabled||input.webResearch===true)&&t.type!=='video'?1:0)+(input.reviewBeforePublish===true&&t.type!=='video'?1:0),0)),0,32,'每次运行的模型调用上限'),
      schedule};
  }
  function save(body,id=randomUUID(),update=false) {
    return transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM task_templates WHERE id=?').get(id);
      if(update && !prior) throw error('模板不存在',404);
      if(prior && body.expectedVersion!==prior.version) throw error('模板版本已更新',409);
      if(typeof body.enabled!=='boolean') throw error('请指定是否启用模板');
      const priorSpec=prior&&JSON.parse(prior.spec);
      const spec=normalize(priorSpec&&!Object.hasOwn(priorSpec,'editorialReview')&&body.spec?.editorialReview===undefined?{...body.spec,editorialReview:false}:body.spec);
      const sameSchedule=prior && JSON.stringify(JSON.parse(prior.spec).schedule)===JSON.stringify(spec.schedule);
      const first=occurrence(spec.schedule,Date.parse(spec.schedule.startAt));
      if(spec.schedule.kind!=='manual' && first===null)throw error('开始与结束日期之间没有可执行的发布时段');
      const version=(prior?.version??0)+1;
      db.prepare('INSERT OR REPLACE INTO task_templates VALUES(?,?,?,?,?)').run(id,version,+body.enabled,JSON.stringify(spec),sameSchedule?prior.next_at:(first===null?null:iso(first)));
      return {id,version};
    });
  }
  function remove(id,expectedVersion) {
    return transaction(db,()=>{
      const template=db.prepare('SELECT version FROM task_templates WHERE id=?').get(id);
      if(!template)throw error('任务已删除或不存在',404);
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==template.version)throw error('任务版本已更新，请刷新后再删除',409);
      db.prepare('DELETE FROM task_templates WHERE id=? AND version=?').run(id,expectedVersion);
      return {id,deleted:true};
    });
  }
  function enqueue(template,key,at) {
    const existing=db.prepare('SELECT id FROM workflow_runs WHERE template_id=? AND run_key=?').get(template.id,key);
    if(existing) return {id:existing.id,reused:true};
    const id=randomUUID();
    const spec=JSON.parse(template.spec);
    if((!spec.taskMode||spec.taskMode==='generate')&&spec.targets.some(t=>t.type==='video'))spec.videoModelId=videoProfileId(spec.videoModelId);
    if(spec.taskMode==='select') {
      spec.assetIds=db.prepare("SELECT a.id FROM assets a JOIN asset_dates d ON d.asset_id=a.id WHERE d.day BETWEEN ? AND ? AND (a.mime LIKE 'image/%' OR a.mime LIKE 'video/%') ORDER BY d.day DESC,a.created DESC,a.id LIMIT 101").all(spec.assetRange.from,spec.assetRange.to).map(a=>a.id);
      if(spec.assetIds.length>100){spec.assetIds=[];spec.selectionError='asset_range_limit';}
    }
    spec.assetMetadata=Object.fromEntries(spec.assetIds.map(id=>{return [id,material(id)];}));
    db.prepare('INSERT INTO workflow_runs(id,template_id,template_version,run_key,scheduled_for,snapshot,call_micros) VALUES(?,?,?,?,?,?,?)')
      .run(id,template.id,template.version,key,at,JSON.stringify(spec),callMicros);
    if(spec.useImageText) {
      for(const assetId of spec.assetIds) db.prepare('INSERT INTO run_asset_text SELECT ?,asset_id,text FROM asset_text WHERE asset_id=?').run(id,assetId);
    }
    spec.targets.forEach((_,slot)=>db.prepare("INSERT INTO workflow_targets(id,run_id,slot,state) VALUES(?,?,?,'pending')").run(randomUUID(),id,slot));
    return {id,reused:false};
  }
  function runNow(id,key) {
    return transaction(db,()=>{
      const template=db.prepare('SELECT * FROM task_templates WHERE id=?').get(id);
      if(!template) throw error('模板不存在',404);
      if(!template.enabled) throw error('模板已停用',409);
      return enqueue(template,'manual/'+string(key,100,'运行标识'),clock());
    });
  }
  function schedule(now) {
    transaction(db,()=>{
      const t=db.prepare(`SELECT * FROM task_templates WHERE enabled=1 AND next_at IS NOT NULL AND
        unixepoch(next_at)-json_extract(spec,'$.schedule.prepareLeadSeconds')<=unixepoch(?) ORDER BY next_at LIMIT 1`).get(iso(now));
      if(!t) return;
      const s=JSON.parse(t.spec).schedule,due=Date.parse(t.next_at);
      if(now<due-s.prepareLeadSeconds*1000)return;
      const selected=now>=due?(occurrence(s,now,true)??due):due;
      if(s.latePolicy==='latest'||now<selected+60000)enqueue(t,'scheduled/'+iso(selected),iso(selected));
      const next=occurrence(s,selected+1);
      db.prepare('UPDATE task_templates SET next_at=? WHERE id=?').run(next===null?null:iso(next),t.id);
    });
  }
  const block=(id,reason)=>db.prepare("UPDATE workflow_targets SET state='blocked',reason=?,lease_until=NULL WHERE id=? AND state IN ('pending','generating','card_pending','rendering','ready','awaiting_review','revision_pending','revising')").run(reason,id);
  function take(now) {
    return transaction(db,()=>{
      db.prepare("UPDATE workflow_targets SET state='awaiting_review',reason='revision_unknown',lease_until=NULL,revision=revision+1 WHERE state='revising' AND lease_until<=?").run(iso(now));
      db.prepare("UPDATE workflow_targets SET state='blocked',reason='generation_unknown' WHERE state='generating' AND lease_until<=?").run(iso(now));
      db.prepare("UPDATE workflow_targets SET state='card_pending',lease_until=NULL WHERE state='rendering' AND lease_until<=?").run(iso(now));
      const row=db.prepare(`SELECT t.*,r.snapshot,r.calls,r.call_micros,r.reserved_micros,r.scheduled_for,r.run_key FROM workflow_targets t JOIN workflow_runs r ON r.id=t.run_id
        WHERE (t.state IN ('pending','card_pending','revision_pending') OR (t.state='ready' AND r.scheduled_for<=?)) AND NOT EXISTS(SELECT 1 FROM video_model_tasks v WHERE v.target_id=t.id AND v.status='pending' AND v.next_at>?) ORDER BY CASE WHEN t.state='ready' THEN 0 ELSE 1 END,r.scheduled_for,t.rowid LIMIT 1`).get(iso(now),iso(now));
      if(!row) return;
      const spec=JSON.parse(row.snapshot),target=spec.targets[row.slot];
      if(spec.selectionError){block(row.id,spec.selectionError);return;}
      const lateness=now-Date.parse(row.scheduled_for);
      if(row.run_key.startsWith('scheduled/') &&
          ((spec.schedule.latePolicy==='skip' && lateness>=60000) ||
           (occurrence(spec.schedule,Date.parse(row.scheduled_for)+1)!==null && now>=occurrence(spec.schedule,Date.parse(row.scheduled_for)+1)))) {
        block(row.id,'missed_schedule');return;
      }
      if(!accountAvailable(target.accountId)) {block(row.id,'account_unavailable');return;}
      if(row.state==='card_pending') {
        const artifact=JSON.parse(row.artifact),lease=iso(now+(artifact.type==='video'?360000:120000));
        db.prepare("UPDATE workflow_targets SET state='rendering',lease_until=? WHERE id=?").run(lease,row.id);
        return {id:row.id,card:artifact,lease,spec,videoAspect:spec.videoAspect,videoModelId:spec.videoModelId};
      }
      if(row.state==='ready') {
        const result=dispatch({content:JSON.parse(row.artifact),accountIds:[target.accountId],publicationPolicy:spec.publicationPolicy,requestKey:'workflow/'+row.id});
        if(result.status!==201 && result.status!==200) {block(row.id,'dispatch_validation');return;}
        db.prepare('UPDATE asset_usage SET used_at=? WHERE target_id=?').run(iso(now),row.id);
        db.prepare("UPDATE workflow_targets SET state='dispatched',dispatch_id=? WHERE id=?").run(result.body.id,row.id);
        return;
      }
      if(row.state==='revision_pending'){
        const lease=iso(now+240000);db.prepare("UPDATE workflow_targets SET state='revising',lease_until=? WHERE id=?").run(lease,row.id);
        return {id:row.id,revisionWork:true,lease,spec,target,assets:JSON.parse(row.authorized_assets),draft:JSON.parse(row.artifact),feedback:row.feedback,revision:row.revision};
      }
      const direct=spec.taskMode==='direct';
      if(!direct && (!writer || writer.available===false)) {block(row.id,'missing_model');return;}
      try {if(!direct)writer.validate?.(spec,target);}catch(error){block(row.id,error.message);return;}
      const callCount=direct?0:(writer.callCount?.(spec,target)??1);
      if(row.calls+callCount>spec.maxCalls) {block(row.id,'budget_exhausted');return;}
      if(callCount && spec.maxMicros!=null && (!row.call_micros || row.reserved_micros+row.call_micros*callCount>spec.maxMicros)) {block(row.id,'cost_limit');return;}
      let assets=spec.assetIds.filter(id=>!cooling(target.accountId,id,spec.assetCooldownSeconds,now)).map(id=>spec.assetMetadata?.[id]||material(id)).filter(Boolean).filter(a=>spec.taskMode!=='select'&&!direct||(target.type==='video'?a.mime.startsWith('video/'):a.mime.startsWith('image/'))).map(asset=>({...asset,description:[asset.note,spec.assetNotes?.[asset.id]].filter(Boolean).join('\n')}));
      if(direct && target.type==='video'){
        const used=id=>db.prepare("SELECT COALESCE(MAX(u.rowid),0) AS at FROM asset_usage u JOIN workflow_targets t ON t.id=u.target_id WHERE u.account_id=? AND u.asset_id=? AND t.state IN ('ready','dispatched')").get(target.accountId,id).at;
        assets.sort((a,b)=>used(a.id)-used(b.id)||spec.assetIds.indexOf(a.id)-spec.assetIds.indexOf(b.id));
        assets=assets.slice(0,1);
      }
      if(!direct&&spec.sourceMode==='content'&&assets.length>8){block(row.id,'source_media_limit');return;}
      if((direct||spec.taskMode==='select')&&!assets.length){block(row.id,'insufficient_assets');return;}
      if(target.type==='note'&&!assets.some(a=>a.mime.startsWith('image/'))&&!spec.imageSearch?.enabled) {block(row.id,'insufficient_assets');return;}
      if(!direct && spec.useImageText) {
        for(const asset of assets.filter(a=>a.mime.startsWith('image/'))) {
          const saved=db.prepare('SELECT text FROM run_asset_text WHERE run_id=? AND asset_id=?').get(row.run_id,asset.id);
          if(!saved)return {analysis:asset.id,runId:row.run_id,id:row.id};
          asset.imageText=saved.text.slice(0,Math.min(2000,Math.floor(20000/assets.length)));
        }
      }
      db.prepare('UPDATE workflow_runs SET calls=calls+?,reserved_micros=reserved_micros+call_micros*? WHERE id=?').run(callCount,callCount,row.run_id);
      db.prepare("UPDATE workflow_targets SET state='generating',lease_until=?,authorized_assets=?,review_phase='planning' WHERE id=?").run(iso(now+240000),JSON.stringify(assets),row.id);
      return {id:row.id,spec,target,assets,direct};
    });
  }
  let busy=false;
  const stop=new AbortController();
  let active=null;
  async function tick() {
    if(busy||isClosed()) return;
    busy=true;
    try {
      const now=Date.parse(clock());
      schedule(now);
      const work=take(now);
      if(!work) return;
      if(work.analysis) {
        try {
          const result=await imageText.analyze(work.analysis);
          if(!isClosed()) db.prepare('INSERT OR IGNORE INTO run_asset_text VALUES(?,?,?)').run(work.runId,work.analysis,result.text);
        } catch {if(!isClosed())block(work.id,'image_text_failed');}
        return;
      }
      const {id,spec,target,assets}=work;let researchSources=[];
      const controller=new AbortController();
      active={id,controller};
      const signal=AbortSignal.any([controller.signal,stop.signal,AbortSignal.timeout(work.card?.type==='video'?300000:(spec?.editorialReview||spec?.imageSearch?.enabled||work.revisionWork?180000:90000))]);
      if(work.revisionWork){
        try{
          const output=await writer.revise({topic:spec.topic,style:spec.style,facts:spec.facts,sourceMode:spec.sourceMode,target,assets,researchSources:JSON.parse(db.prepare('SELECT research_sources FROM workflow_targets WHERE id=?').get(id).research_sources),draft:work.draft,feedback:work.feedback},{signal});
          if(isClosed())return;signal.throwIfAborted();
          const formatted=reportContent(output,assets,{requireImages:target.type==='note'||spec.imageSearch?.enabled,sources:work.revisionWork?JSON.parse(db.prepare('SELECT research_sources FROM workflow_targets WHERE id=?').get(id).research_sources):researchSources});
          if(typeof output.reviewNotes!=='string'||output.reviewNotes.length>2000)throw Error('invalid_editorial_review');
          const revised={...work.draft,...formatted,reviewNotes:output.reviewNotes,agentModelId:output.agentModelId,publication:{...work.draft.publication,aiAssisted:true}};
          transaction(db,()=>{const saved=db.prepare("UPDATE workflow_targets SET artifact=?,state='awaiting_review',review_phase='reviewed',reason=NULL,lease_until=NULL,revision=revision+1 WHERE id=? AND state='revising' AND revision=? AND lease_until=? AND lease_until>?").run(JSON.stringify(revised),id,work.revision,work.lease,clock());if(saved.changes){if(revised.assetIds.some(assetId=>cooling(target.accountId,assetId,spec.assetCooldownSeconds,Date.parse(clock()))&&!db.prepare('SELECT 1 FROM asset_usage WHERE target_id=? AND asset_id=?').get(id,assetId)))throw Error('asset_cooldown');record(id,'agent按用户意见审改');db.prepare('DELETE FROM asset_usage WHERE target_id=?').run(id);for(const assetId of revised.assetIds)db.prepare('INSERT INTO asset_usage VALUES(?,?,?,?)').run(id,target.accountId,assetId,clock());}});
        }catch{if(!isClosed())db.prepare("UPDATE workflow_targets SET state='awaiting_review',reason='revision_unknown',lease_until=NULL,revision=revision+1 WHERE id=? AND state='revising' AND revision=?").run(id,work.revision);}
        return;
      }
      if(work.card) {
        try {
          const isVideo=work.card.type=== 'video';
          const result=isVideo?await makeVideo(id,work.card,work.videoAspect,signal,work.videoModelId):await makeCard(work.card,signal);
          if(isClosed())return;
          if(signal.aborted)throw Error('card_aborted');
          transaction(db,()=>{
            if(!db.prepare("SELECT 1 FROM workflow_targets WHERE id=? AND state='rendering' AND lease_until=?").get(id,work.lease))return;
            const cardId=storeCard(id,work.card.title,isVideo?result.cover:result);
            if(isVideo) {
              const videoId=storeVideo(id,work.card.title,result.video);
              work.card.sourceAssetIds=work.card.assetIds;
              work.card.assetIds=[videoId];work.card.generatedVideoId=videoId;
              if(cardId)work.card.coverAssetId=cardId;
              work.card.videoPlan=result.plan;work.card.videoDuration=result.duration;
              work.card.videoWidth=result.width;work.card.videoHeight=result.height;
            } else work.card.assetIds.unshift(cardId);
            if(cardId)work.card.generatedCoverId=cardId;
            if(isVideo)db.prepare("UPDATE video_model_tasks SET status='complete' WHERE target_id=?").run(id);
            db.prepare("UPDATE workflow_targets SET artifact=?,state=?,lease_until=NULL,revision=revision+1 WHERE id=?").run(JSON.stringify(work.card),reviewState(spec||JSON.parse(db.prepare('SELECT snapshot FROM workflow_runs r JOIN workflow_targets t ON t.run_id=r.id WHERE t.id=?').get(id).snapshot),work.card),id);record(id,'媒体准备完成');
          });
        } catch(error) {
          if(!isClosed() && error.code==='video_pending') {
            db.prepare("UPDATE workflow_targets SET state='card_pending',lease_until=NULL WHERE id=? AND state='rendering' AND lease_until=?").run(id,work.lease);return;
          }
          if(!isClosed())db.prepare("UPDATE workflow_targets SET state='blocked',reason=?,lease_until=NULL WHERE id=? AND state='rendering' AND lease_until=?").run(work.card.type==='video'?(error.code||'video_provider_failed'):'card_render_failed',id,work.lease);
        }
        return;
      }
      let output;
      try {output=work.direct?{title:spec.topic,body:spec.facts||spec.topic,assetIds:assets.map(a=>a.id)}:await writer({taskMode:spec.taskMode,generationModelId:spec.generationModelId,sourceMode:spec.sourceMode,editorialReview:spec.editorialReview,imageSearch:spec.imageSearch,webResearch:spec.webResearch,topic:spec.topic,style:spec.style,facts:spec.facts,target,assets},{signal,reserveSearchCall:()=>{signal.throwIfAborted();if(isClosed())throw Error('closed');const saved=db.prepare("UPDATE workflow_targets SET search_calls=search_calls+1 WHERE id=? AND state='generating' AND search_calls<?").run(id,spec.maxSearchRequests??4);if(!saved.changes)throw Object.assign(Error('search_request_limit'),{code:'search_request_limit'});},onResearch:sources=>{signal.throwIfAborted();if(isClosed())throw Error('closed');researchSources=sources;db.prepare("UPDATE workflow_targets SET research_sources=? WHERE id=? AND state='generating'").run(JSON.stringify(sources),id);},onAssets:added=>{signal.throwIfAborted();if(isClosed())throw Error('closed');assets.push(...added.filter(a=>!assets.some(b=>b.id===a.id)));db.prepare("UPDATE workflow_targets SET authorized_assets=? WHERE id=? AND state='generating'").run(JSON.stringify(assets),id);},onDraft:draft=>{signal.throwIfAborted();if(isClosed())throw Error('closed');const saved=JSON.stringify({title:draft?.title,body:draft?.body,assetIds:draft?.assetIds,blocks:draft?.blocks});if(saved.length>250000)throw Error('invalid_artifact');db.prepare("UPDATE workflow_targets SET draft=?,review_phase='reviewing' WHERE id=? AND state='generating'").run(saved,id);}});}
      catch(error) {if(!isClosed()) block(id,['missing_generation_model','same_generation_model','vision_required','source_media_limit','source_media_size','image_search_failed','missing_search_key','search_auth_failed','search_balance_required','search_rate_limited','domestic_search_failed','domestic_search_empty','domestic_search_unconfigured','search_request_limit','search_query_too_long','image_search_empty','invalid_image_queries','invalid_editorial_review'].includes(error.message)?error.message:'generation_unknown');return;}
      if(isClosed()) return;
      if(signal.aborted) {block(id,'generation_unknown');return;}
            if(target.type==='video' && (!spec.taskMode||spec.taskMode==='generate')) {
        if(!Array.isArray(output?.scenes)||!output.scenes.length||output.scenes.length>8 ||
            output.scenes.some(s=>(s.assetId!=null && !assets.some(a=>a.id===s.assetId))||typeof s.text!=='string'||!s.text.trim()||s.text.length>80)) {
          block(id,'invalid_artifact');return;
        }
        output.assetIds=[...new Set(output.scenes.map(s=>s.assetId).filter(Boolean))];
      }
      if(target.type!=='video'){try{output={...output,...reportContent(output,assets,{requireImages:target.type==='note'||spec.imageSearch?.enabled,sources:researchSources})};}catch{block(id,'invalid_artifact');return;}}
      if(typeof output?.title!=='string'||!output.title.trim()||output.title.length>500 ||
          typeof output.body!=='string'||!output.body.trim()||output.body.length>100000 ||
          !Array.isArray(output.assetIds)||output.assetIds.some(id=>!assets.some(a=>a.id===id && (target.type==='video'?(spec.taskMode&&spec.taskMode!=='generate'?a.mime.startsWith('video/'):true):a.mime.startsWith('image/')))) ||
          (target.type==='note'&&!output.assetIds.length) || (target.type==='video'&&spec.taskMode&&spec.taskMode!=='generate'&&output.assetIds.length!==1)) {block(id,'invalid_artifact');return;}
      const artifact={type:target.type,title:output.title.trim(),body:output.body.trim(),assetIds:[...new Set(output.assetIds)],
        publication:{mode:spec.mode,aiAssisted:!work.direct,silent:true,...(target.platform==='douyin'&&spec.douyinVisibility?{douyinVisibility:spec.douyinVisibility}:{})}};
      if(target.type!=='video')Object.assign(artifact,{researchSources,blocks:output.blocks,bodyHtml:output.bodyHtml,reviewNotes:typeof output.reviewNotes==='string'?output.reviewNotes:'',agentModelId:output.agentModelId});
      if(output.generationPrompt)Object.assign(artifact,{generationPrompt:output.generationPrompt,agentModelId:output.agentModelId,generationModelId:output.generationModelId});
      if(target.type==='video'&&(!spec.taskMode||spec.taskMode==='generate')){
        if(output.videoPrompt!=null&&(typeof output.videoPrompt!=='string'||!output.videoPrompt.trim()||output.videoPrompt.length>10000)){block(id,'invalid_artifact');return;}
        artifact.scenes=output.scenes.map(s=>({assetId:s.assetId,text:s.text.trim()}));
        artifact.videoPrompt=output.videoPrompt?.trim()||artifact.scenes.map(s=>s.text).join('\n');
      }
      transaction(db,()=>{
        const at=clock();
        if(artifact.assetIds.some(asset=>cooling(target.accountId,asset,spec.assetCooldownSeconds,Date.parse(at)))) {
          block(id,'asset_cooldown');return;
        }
        const saved=db.prepare("UPDATE workflow_targets SET state=?,artifact=?,lease_until=NULL,review_phase='reviewed',revision=revision+1 WHERE id=? AND state='generating' AND lease_until>?")
          .run(((target.type==='video'&&(!spec.taskMode||spec.taskMode==='generate'))||(!work.direct&&spec.noteCard && target.type==='note'))?'card_pending':reviewState(spec,artifact),JSON.stringify(artifact),id,at);
        if(saved.changes)record(id,'生成成品');
        if(saved.changes)for(const asset of artifact.assetIds)
          db.prepare('INSERT INTO asset_usage VALUES(?,?,?,?)').run(id,target.accountId,asset,at);
      });
    } finally {active=null;busy=false;}
  }
  function details(id) {
    const row=db.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id);
    if(!row) throw error('运行不存在',404);
    const videoTasks=db.prepare('SELECT v.target_id,v.status,v.remote_id,v.created_at,v.next_at,v.deadline,v.reserved_micros,v.profile_id FROM video_model_tasks v JOIN workflow_targets t ON t.id=v.target_id WHERE t.run_id=?').all(id);
    return {...row,videoTasks,snapshot:JSON.parse(row.snapshot),targets:db.prepare('SELECT * FROM workflow_targets WHERE run_id=? ORDER BY slot').all(id)
      .map(t=>({...t,research_sources:JSON.parse(t.research_sources),draft:t.draft&&JSON.parse(t.draft),authorized_assets:JSON.parse(t.authorized_assets),versions:db.prepare('SELECT revision,artifact,note,created_at FROM workflow_artifact_versions WHERE target_id=? ORDER BY revision').all(t.id).map(v=>({...v,artifact:JSON.parse(v.artifact)})),artifact:t.artifact&&JSON.parse(t.artifact),job:t.dispatch_id?(()=>{const job=db.prepare('SELECT id,state FROM jobs WHERE dispatch_id=?').get(t.dispatch_id);return job?{...job,publication:publicationSummary(job.id)}:null;})():null}))};
  }
  function referenced(field,value) {
    if(field==='asset' && db.prepare("SELECT 1 FROM workflow_targets t,json_each(t.authorized_assets) a WHERE t.state IN ('generating','awaiting_review','revision_pending','revising','ready','blocked','card_pending','rendering') AND json_extract(a.value,'$.id')=? LIMIT 1").get(value))return true;
    if(field==='asset' && db.prepare("SELECT 1 FROM workflow_targets WHERE state IN ('ready','blocked') AND json_extract(artifact,'$.generatedCoverId')=?").get(value))return true;
    const match=s=>field==='account'?s.targets.some(t=>t.accountId===value):s.assetIds.includes(value);
    const specs=db.prepare(`SELECT spec FROM task_templates WHERE enabled=1 UNION SELECT snapshot AS spec FROM workflow_runs r
      WHERE EXISTS(SELECT 1 FROM workflow_targets t WHERE t.run_id=r.id AND t.state IN ('pending','generating','card_pending','rendering','ready','awaiting_review','revision_pending','revising'))`).all();
    return specs.some(row=>match(JSON.parse(row.spec)));
  }
  function stopRun(id) {
    details(id);
    db.prepare("UPDATE workflow_targets SET state='cancelled' WHERE run_id=? AND state IN ('pending','generating','card_pending','rendering','ready','awaiting_review','revision_pending','revising','blocked')").run(id);
    if(active && db.prepare("SELECT 1 FROM workflow_targets WHERE id=? AND run_id=? AND state='cancelled'").get(active.id,id))
      active.controller.abort();
    return details(id);
  }
  function resumeTarget(id,targetId) {
    const target=db.prepare('SELECT * FROM workflow_targets WHERE id=? AND run_id=?').get(targetId,id);
    if(!target || target.state!=='blocked' || !['missing_generation_model','same_generation_model','vision_required','source_media_limit','source_media_size','missing_model','missing_search_key','domestic_search_unconfigured','account_unavailable','dispatch_validation','insufficient_assets','image_text_failed','card_render_failed','missing_video_model','video_provider_changed','video_call_limit','video_budget_unconfigured','video_provider_failed','video_download_host','video_download_failed','video_too_large','invalid_video_output'].includes(target.reason))
      throw error('该目标不能安全重试',409);
    if(!target.artifact && JSON.parse(db.prepare('SELECT snapshot FROM workflow_runs WHERE id=?').get(id).snapshot).taskMode!=='direct' && (!writer || writer.available===false)) throw error('生成模型未配置',409);
    const artifact=target.artifact && JSON.parse(target.artifact);
    const spec=JSON.parse(db.prepare('SELECT snapshot FROM workflow_runs WHERE id=?').get(id).snapshot);
    const ready=artifact && ((artifact.type==='video'&&(!spec.taskMode||spec.taskMode==='generate'))||(spec.taskMode!=='direct'&&spec.noteCard && artifact.type==='note')) && !(artifact.generatedVideoId||artifact.generatedCoverId)?'card_pending':'ready';
    db.prepare("UPDATE workflow_targets SET state=?,reason=NULL WHERE id=? AND state='blocked'")
      .run(artifact?ready:'pending',targetId);
    return details(id);
  }
  function reviewTarget(runId,targetId,body,action){
    return transaction(db,()=>{
      const row=db.prepare('SELECT t.*,r.snapshot,r.calls,r.call_micros,r.reserved_micros FROM workflow_targets t JOIN workflow_runs r ON r.id=t.run_id WHERE t.id=? AND t.run_id=?').get(targetId,runId);
      if(!row||row.state!=='awaiting_review'||row.dispatch_id)throw error('仅可修改或确认尚未分发的待审稿件',409);
      if(!Number.isInteger(body.expectedRevision)||body.expectedRevision!==row.revision)throw error('稿件版本已更新，请重新打开',409);
      const spec=JSON.parse(row.snapshot),target=spec.targets[row.slot],assets=JSON.parse(row.authorized_assets),prior=JSON.parse(row.artifact);
      if(action==='revise'){
        if(!writer?.revise||writer.available===false||writer.reviewAvailable===false)throw error('主agent模型未配置',409);
        const feedback=string(body.feedback,2000,'修改意见');
        if(row.calls+1>spec.maxCalls)throw error('本次运行的模型调用预算已用尽',409);
        if(spec.maxMicros!=null&&(!row.call_micros||row.reserved_micros+row.call_micros>spec.maxMicros))throw error('本次运行费用预留已达上限',409);
        db.prepare('UPDATE workflow_runs SET calls=calls+1,reserved_micros=reserved_micros+call_micros WHERE id=?').run(runId);
        db.prepare("UPDATE workflow_targets SET state='revision_pending',feedback=?,revision=revision+1,reason=NULL WHERE id=?").run(feedback,targetId);
      }else if(action==='approve'){
        if(prior.assetIds.some(id=>cooling(target.accountId,id,spec.assetCooldownSeconds,Date.parse(clock()))&&!db.prepare('SELECT 1 FROM asset_usage WHERE target_id=? AND asset_id=?').get(targetId,id)))throw error('素材仍在冷却',409);
        db.prepare("UPDATE workflow_targets SET state='ready',revision=revision+1,reason=NULL WHERE id=?").run(targetId);
      }else{
        const available=[...assets,...(prior.generatedCoverId?[db.prepare('SELECT id,name,mime FROM assets WHERE id=?').get(prior.generatedCoverId)]:[])].filter(Boolean);
        const formatted=reportContent(body,available,{requireImages:target.type==='note'||spec.imageSearch?.enabled,sources:prior.researchSources||[]});
        if(formatted.assetIds.some(id=>!db.prepare('SELECT 1 FROM assets WHERE id=?').get(id)))throw error('部分图片已被删除',409);
        if(formatted.assetIds.some(id=>cooling(target.accountId,id,spec.assetCooldownSeconds,Date.parse(clock()))&&!db.prepare('SELECT 1 FROM asset_usage WHERE target_id=? AND asset_id=?').get(targetId,id)))throw error('素材仍在冷却',409);
        const artifact={...prior,...formatted};db.prepare('UPDATE workflow_targets SET artifact=?,revision=revision+1,reason=NULL WHERE id=?').run(JSON.stringify(artifact),targetId);
        db.prepare('DELETE FROM asset_usage WHERE target_id=?').run(targetId);for(const id of artifact.assetIds)db.prepare('INSERT INTO asset_usage VALUES(?,?,?,?)').run(targetId,target.accountId,id,clock());
        record(targetId,'用户修改成品');
      }
      return details(runId);
    });
  }
  return {save,remove,runNow,tick,details,stopRun,resumeTarget,referenced,reviewTarget,close:()=>stop.abort(),
    templates:()=>db.prepare('SELECT * FROM task_templates ORDER BY rowid DESC').all().map(t=>({...t,enabled:!!t.enabled,spec:JSON.parse(t.spec)})),
    runs:()=>db.prepare("SELECT id,template_id,scheduled_for,calls,json_extract(snapshot,'$.topic') AS topic FROM workflow_runs ORDER BY rowid DESC LIMIT 100").all()};
}
