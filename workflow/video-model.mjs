import {createHash} from 'node:crypto';
const fault=(code)=>Object.assign(Error(code),{code});
function endpoint(value,download=false) {
  const url=new URL(value);
  if(url.username||url.password||url.hash||(!download&&url.search)||
    (url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw fault('invalid_video_endpoint');
  return url;
}
// A provider adapter or local gateway implements POST jobs and GET jobs/{id}.
// Actual provider-specific schemas are adapted outside the workflow ledger.
export function configuredVideoProvider(env=process.env,request=fetch) {
  if(!env.MATRIX_VIDEO_ENDPOINT)return null;
  const url=endpoint(env.MATRIX_VIDEO_ENDPOINT);
  const wan=(env.MATRIX_VIDEO_PROVIDER||'wan3')==='wan3';
  if(!wan && env.MATRIX_VIDEO_PROVIDER!=='json')throw fault('unsupported_video_provider');
  const model=env.MATRIX_VIDEO_MODEL||(wan?'wan3.0-video':null);
  if(!model)throw fault('missing_video_model');
  if(wan && (url.protocol!=='https:'||!url.hostname.endsWith('.maas.aliyuncs.com') ||
    url.pathname!=='/api/v1/services/aigc/video-generation/video-synthesis'))throw fault('invalid_wan_endpoint');
  const duration=Number(env.MATRIX_VIDEO_DURATION??5),resolution=env.MATRIX_VIDEO_RESOLUTION||'720P',audio=env.MATRIX_VIDEO_AUDIO!=='0';
  if(wan && (!Number.isInteger(duration)||duration<2||duration>30||!['480P','720P','1080P'].includes(resolution)))throw fault('invalid_wan_parameters');
  const headers={'Content-Type':'application/json',...(env.MATRIX_VIDEO_KEY?{Authorization:'Bearer '+env.MATRIX_VIDEO_KEY}:{})};
  async function json(target,options) {
    const response=await request(target,{...options,headers:options.headers||headers,redirect:'error'});
    if(!response.ok)throw Object.assign(fault('video_provider_failed'),{retryable:response.status===429||response.status>=500});
    return response.json();
  }
  return {
    identity:createHash('sha256').update(JSON.stringify([wan,url.href,model,duration,resolution,...(audio?[]:[false])])).digest('hex'),
    create:async(prompt,key,signal)=>{
      const body=wan?{model,input:{prompt:prompt.prompt},parameters:{resolution,duration,ratio:prompt.aspect_ratio,audio}}:{model,request_id:key,...prompt,duration,resolution,audio};
      const result=await json(url,{method:'POST',signal,headers:wan?{...headers,'X-DashScope-Async':'enable'}:headers,body:JSON.stringify(body)});
      return wan?{id:result.output?.task_id}:result;
    },
    check:async(id,signal)=>{
      const result=await json(wan?new URL('/api/v1/tasks/'+encodeURIComponent(id),url):new URL(url.href.replace(/\/$/,'')+'/'+encodeURIComponent(id)),{signal});
      if(!wan)return result;
      const status=result.output?.task_status;
      return {status:status==='SUCCEEDED'?'succeeded':['FAILED','CANCELED','UNKNOWN'].includes(status)?'failed':'running',video_url:result.output?.video_url};
    },
    download:async(href,signal)=>{
      const target=endpoint(href,true);
      const allowed=(env.MATRIX_VIDEO_DOWNLOAD_HOSTS||url.hostname).split(',').map(x=>x.trim());
      const officialResult=wan && (/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(target.hostname)||/^dashscope-[a-z0-9-]+\.oss-accelerate\.aliyuncs\.com$/.test(target.hostname));
      if(!allowed.includes(target.hostname) && !officialResult)throw fault('video_download_host');
      const response=await request(target,{signal,redirect:'error'});
      if(!response.ok || Number(response.headers.get('content-length'))>150*1024*1024)throw fault('video_download_failed');
      const chunks=[];let size=0;
      for await(const part of response.body){size+=part.length;if(size>150*1024*1024)throw fault('video_too_large');chunks.push(part);}
      const video=Buffer.concat(chunks);
      if(video.toString('ascii',4,8)!=='ftyp')throw fault('invalid_video_output');
      return video;
    }
  };
}
export function videoJobs({db,provider,resolveProvider,clock,callMicros,maxMicros,isClosed}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=13').get()) {
      db.exec(`CREATE TABLE video_model_tasks(target_id TEXT PRIMARY KEY,status TEXT NOT NULL,remote_id TEXT,
        created_at TEXT NOT NULL,next_at TEXT NOT NULL,deadline TEXT NOT NULL,reserved_micros INTEGER NOT NULL,
        result_url TEXT);`);
      db.prepare('INSERT INTO schema_migrations VALUES(13,?)').run(clock());
    }
    if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=14').get()) {
      db.exec("ALTER TABLE video_model_tasks ADD COLUMN provider_key TEXT");
      db.prepare('INSERT INTO schema_migrations VALUES(14,?)').run(clock());
    }
    if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=16').get()) {
      db.exec('ALTER TABLE video_model_tasks ADD COLUMN profile_id TEXT; ALTER TABLE video_model_tasks ADD COLUMN poll_failures INTEGER NOT NULL DEFAULT 0');
      db.prepare('INSERT INTO schema_migrations VALUES(16,?)').run(clock());
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return async function generate(targetId,artifact,aspect,signal,profileId=null) {
    let row=db.prepare('SELECT * FROM video_model_tasks WHERE target_id=?').get(targetId);
    let config;
    try {config=resolveProvider?resolveProvider(row?(row.profile_id||'environment'):profileId):{provider,callMicros,maxMicros};}
    catch{throw fault('missing_video_model');}
    const selected=config.provider,cost=config.callMicros,budget=config.maxMicros;
    if(!selected)throw fault('missing_video_model');
    if(row && row.provider_key!== (selected.identity||'injected'))throw fault('video_provider_changed');
    if(!row) {
      if(!config.allowUnpriced&&(!Number.isSafeInteger(cost)||cost<=0||!Number.isSafeInteger(budget)||budget<cost))throw fault('video_budget_unconfigured');
      const now=clock();
      db.exec('BEGIN IMMEDIATE');
      let claimed;
      try {
        const run=db.prepare('SELECT run_id FROM workflow_targets WHERE id=?').get(targetId);
        const spent=run?db.prepare('SELECT COALESCE(SUM(v.reserved_micros),0) AS n FROM video_model_tasks v JOIN workflow_targets t ON t.id=v.target_id WHERE t.run_id=?').get(run.run_id).n:0;
        const count=run?db.prepare('SELECT COUNT(*) AS n FROM video_model_tasks v JOIN workflow_targets t ON t.id=v.target_id WHERE t.run_id=?').get(run.run_id).n:0;
        if(config.maxGenerations&&count>=config.maxGenerations)throw fault('video_call_limit');
        if(budget!=null&&spent+cost>budget)throw fault('video_budget_unconfigured');
        claimed=db.prepare("INSERT OR IGNORE INTO video_model_tasks(target_id,status,remote_id,created_at,next_at,deadline,reserved_micros,result_url,provider_key,profile_id) VALUES(?,'invoking',NULL,?,?,?, ?,NULL,?,?)")
        .run(targetId,now,now,new Date(Date.parse(now)+86400000).toISOString(),cost,selected.identity||'injected',config.id||null);
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
      if(!claimed.changes)throw fault('video_pending');
      let job;
      try {job=await selected.create({prompt:artifact.videoPrompt||artifact.scenes.map(s=>s.text).join('\n'),aspect_ratio:aspect==='landscape'?'16:9':'9:16'},targetId,signal);}
      catch{if(isClosed())throw fault('closed');db.prepare("UPDATE video_model_tasks SET status='unknown' WHERE target_id=?").run(targetId);throw fault('video_creation_unknown');}
      if(isClosed())throw fault('closed');
      if(typeof job?.id!=='string'||!job.id||job.id.length>256){db.prepare("UPDATE video_model_tasks SET status='unknown' WHERE target_id=?").run(targetId);throw fault('video_creation_unknown');}
      db.prepare("UPDATE video_model_tasks SET status='pending',remote_id=? WHERE target_id=?").run(job.id,targetId);
      row=db.prepare('SELECT * FROM video_model_tasks WHERE target_id=?').get(targetId);
    }
    if(['unknown','invoking'].includes(row.status))throw fault('video_creation_unknown');
    if(row.status==='failed'||clock()>=row.deadline)throw fault('video_generation_failed');
    if(row.status==='complete')throw fault('video_result_already_used');
    if(clock()<row.next_at)throw fault('video_pending');
    if(row.status!=='download') {
      const claimed=db.prepare("UPDATE video_model_tasks SET next_at=? WHERE target_id=? AND next_at<=?")
        .run(new Date(Date.parse(clock())+30000).toISOString(),targetId,clock());
      if(!claimed.changes)throw fault('video_pending');
      let result;
      try {result=await selected.check(row.remote_id,signal);}
      catch(error){
        if(isClosed())throw fault('closed');
        if(error.retryable!==false && row.poll_failures<5){db.prepare('UPDATE video_model_tasks SET poll_failures=poll_failures+1 WHERE target_id=?').run(targetId);throw fault('video_pending');}
        throw fault('video_provider_failed');
      }
      if(isClosed())throw fault('closed');
      db.prepare('UPDATE video_model_tasks SET poll_failures=0 WHERE target_id=?').run(targetId);
      if(result.status==='failed'){db.prepare("UPDATE video_model_tasks SET status='failed' WHERE target_id=?").run(targetId);throw fault('video_generation_failed');}
      if(result.status!=='succeeded'||typeof result.video_url!=='string')throw fault('video_pending');
      db.prepare("UPDATE video_model_tasks SET status='download',result_url=? WHERE target_id=?").run(result.video_url,targetId);
      row=db.prepare('SELECT * FROM video_model_tasks WHERE target_id=?').get(targetId);
    }
    try {return {video:await selected.download(row.result_url,signal)};}
    catch(error) {
      if(!isClosed())db.prepare("UPDATE video_model_tasks SET status='pending',result_url=NULL,next_at=? WHERE target_id=? AND status='download'")
        .run(clock(),targetId);
      throw fault(['video_download_host','video_download_failed','video_too_large','invalid_video_output'].includes(error.code)?error.code:'video_provider_failed');
    }
  };
}
