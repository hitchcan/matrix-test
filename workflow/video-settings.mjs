import {randomUUID} from 'node:crypto';
import {configuredVideoProvider} from './video-model.mjs';
const fail=(message,status=422)=>Object.assign(Error(message),{status});
export function videoSettings(db,env=process.env,request=fetch) {
  db.exec('CREATE TABLE IF NOT EXISTS video_profiles(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS video_settings(id INTEGER PRIMARY KEY CHECK(id=1),profile_id TEXT NOT NULL)');
  const environment=()=>({id:'environment',name:'环境变量视频配置',provider:env.MATRIX_VIDEO_PROVIDER||'wan3',endpoint:env.MATRIX_VIDEO_ENDPOINT||'',model:env.MATRIX_VIDEO_MODEL||((env.MATRIX_VIDEO_PROVIDER||'wan3')==='wan3'?'wan3.0-video':''),key:env.MATRIX_VIDEO_KEY||'',duration:Number(env.MATRIX_VIDEO_DURATION??5),resolution:env.MATRIX_VIDEO_RESOLUTION||'720P',audio:env.MATRIX_VIDEO_AUDIO!=='0',downloadHosts:env.MATRIX_VIDEO_DOWNLOAD_HOSTS||'',callMicros:Number(env.MATRIX_VIDEO_CALL_MICROS??0),maxMicros:Number(env.MATRIX_VIDEO_BUDGET_MICROS??0),maxGenerations:32,allowUnpriced:false});
  function get(id) {
    if(id!=null&&(typeof id!=='string'||id.length>100))throw fail('视频配置ID无效');
    id ||= db.prepare('SELECT profile_id FROM video_settings WHERE id=1').get()?.profile_id||'environment';
    if(id==='environment')return environment();
    const row=db.prepare('SELECT value FROM video_profiles WHERE id=?').get(id);
    if(!row)throw fail('视频模型配置不存在',404);return JSON.parse(row.value);
  }
  const toEnv=p=>({MATRIX_VIDEO_PROVIDER:p.provider,MATRIX_VIDEO_ENDPOINT:p.endpoint,MATRIX_VIDEO_MODEL:p.model,MATRIX_VIDEO_KEY:p.key,MATRIX_VIDEO_DURATION:p.duration,MATRIX_VIDEO_RESOLUTION:p.resolution,MATRIX_VIDEO_AUDIO:p.audio?'1':'0',MATRIX_VIDEO_DOWNLOAD_HOSTS:p.downloadHosts});
  const safe=p=>{const {key,allowUnpriced,...rest}=p;return {...rest,hasKey:!!key,configured:!!p.endpoint&&!!p.model&&(p.provider!=='wan3'||!!key)};};
  function view(){const active=get(),profiles=db.prepare('SELECT value FROM video_profiles ORDER BY rowid').all().map(r=>safe(JSON.parse(r.value)));if(environment().endpoint)profiles.unshift(safe(environment()));return {...safe(active),activeId:active.id,profiles};}
  function save(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','create','activate','name','provider','endpoint','model','key','clearKey','duration','resolution','audio','downloadHosts','callMicros','maxMicros','maxGenerations'].includes(k)))throw fail('视频模型配置无效');
    for(const k of ['create','activate','clearKey','audio'])if(input[k]!==undefined&&typeof input[k]!=='boolean')throw fail('视频模型配置无效');
    if(input.id!==undefined&&(typeof input.id!=='string'||input.id.length>100))throw fail('视频模型配置无效');
    const prior=input.create?{}:get(input.id);
    for(const k of ['endpoint','model','provider'])if(typeof input[k]!=='string'||!input[k].trim()||input[k].length>2048)throw fail('请填写视频供应商、完整接口地址和模型名称');
    for(const k of ['key','name','downloadHosts'])if(input[k]!==undefined&&(typeof input[k]!=='string'||input[k].length>(k==='key'?4096:k==='name'?100:2048)))throw fail('视频模型配置无效');
    const p={id:input.create||prior.id==='environment'?randomUUID():prior.id,name:input.name?.trim()||input.model.trim(),provider:input.provider,endpoint:input.endpoint.trim(),model:input.model.trim(),key:input.clearKey?'':input.key||((prior.endpoint===input.endpoint.trim()&&prior.provider===input.provider)?prior.key||'':''),duration:input.duration??5,resolution:input.resolution||'720P',audio:input.audio!==false,downloadHosts:input.downloadHosts?.trim()||'',callMicros:input.callMicros??0,maxMicros:input.maxMicros??null,maxGenerations:input.maxGenerations??4,allowUnpriced:true};
    if(!Number.isInteger(p.duration)||p.duration<2||p.duration>30||!['480P','720P','1080P'].includes(p.resolution)||!Number.isSafeInteger(p.maxGenerations)||p.maxGenerations<1||p.maxGenerations>32)throw fail('视频时长需为2–30秒，每次运行生成次数需为1–32次');
    if(!Number.isSafeInteger(p.callMicros)||p.callMicros<0||p.callMicros>1e9||(p.maxMicros!==null&&(!Number.isSafeInteger(p.maxMicros)||p.maxMicros<p.callMicros||p.maxMicros>1e9))||(p.callMicros>0&&p.maxMicros===null)||(p.callMicros===0&&p.maxMicros!==null))throw fail('费用估算与上限请同时填写正整数，或都留空使用次数限制');
    const hosts=p.downloadHosts?p.downloadHosts.split(',').map(h=>h.trim()):[];
    if(hosts.some(h=>!/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(h)))throw fail('下载域名请填写主机名，用英文逗号分隔，不含协议或路径');
    try{configuredVideoProvider(toEnv(p),request);}catch{throw fail('视频接口或参数无效；万相需使用所属地域及 Workspace 的官方完整地址');}
    db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT OR REPLACE INTO video_profiles VALUES(?,?)').run(p.id,JSON.stringify(p));if(input.activate!==false||get().id===p.id)db.prepare('INSERT OR REPLACE INTO video_settings VALUES(1,?)').run(p.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return {...view(),savedId:p.id};
  }
  function select(id){if(typeof id!=='string'||!id)throw fail('请选择视频模型配置');const p=get(id);if(!safe(p).configured)throw fail('视频配置不完整，请填写接口、模型及API Key');db.prepare('INSERT OR REPLACE INTO video_settings VALUES(1,?)').run(p.id);return view();}
  function capture(id){const p=get(id);return {id:p.id,provider:safe(p).configured?configuredVideoProvider(toEnv(p),request):null,callMicros:p.callMicros,maxMicros:p.maxMicros,maxGenerations:p.maxGenerations,allowUnpriced:p.allowUnpriced};}
  function check(id){const p=get(id);try{if(!safe(p).configured||!configuredVideoProvider(toEnv(p),request))throw Error();return {ok:true,message:'本地配置检查通过；未调用生成接口，密钥权限及真实生成需运行任务验证'};}catch{throw fail('视频配置不完整或参数无效，请检查地址、模型和API Key');}}
  return {view,save,select,capture,check,resolveId:id=>id?get(id).id:view().configured?get().id:null};
}
