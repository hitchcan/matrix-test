import {randomUUID} from 'node:crypto';
import {configuredPlanner,configuredWriter,configuredPromptAgent,configuredProbe,configuredEditor,configuredImageQueries} from './model-gateway.mjs';
const fault=(message,status=422)=>Object.assign(Error(message),{status});
export function modelSettings(db,env=process.env) {
  db.exec('CREATE TABLE IF NOT EXISTS model_settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS model_profiles(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const stored=()=>{const row=db.prepare('SELECT value FROM model_settings WHERE id=1').get();return row?JSON.parse(row.value):null;};
  const legacy=stored();
  if(legacy&&!legacy.id) {
    const value={...legacy,id:'legacy',name:legacy.model};
    db.prepare('INSERT OR IGNORE INTO model_profiles VALUES(?,?)').run(value.id,JSON.stringify(value));
    db.prepare('UPDATE model_settings SET value=? WHERE id=1').run(JSON.stringify(value));
  }
  const environment=()=>({id:'environment',name:'环境变量配置',endpoint:env.MATRIX_MODEL_ENDPOINT||'',model:env.MATRIX_MODEL_NAME||'',key:env.MATRIX_MODEL_KEY||'',vision:env.MATRIX_MODEL_VISION==='1'});
  const effective=()=>stored()||environment();
  function get(id) {
    if(!id)return effective();
    if(id==='environment')return environment();
    const row=db.prepare('SELECT value FROM model_profiles WHERE id=?').get(id);
    if(!row)throw fault('模型配置不存在',404);return JSON.parse(row.value);
  }
  const safe=value=>{const {key,...rest}=value;return {...rest,hasKey:!!key,configured:!!(value.endpoint&&value.model)};};
  function view() {
    const active=effective(),profiles=db.prepare('SELECT value FROM model_profiles ORDER BY rowid').all().map(r=>safe(JSON.parse(r.value)));
    if(environment().endpoint&&environment().model)profiles.unshift(safe(environment()));
    return {...safe(active),activeId:active.id,profiles,source:stored()?'user':'environment'};
  }
  function save(input) {
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['id','name','create','activate','endpoint','model','key','clearKey','vision'].includes(k))||
      typeof input.endpoint!=='string'||typeof input.model!=='string'||input.endpoint.length>2048||input.model.length>200||
      (input.id!==undefined&&typeof input.id!=='string')||(input.name!==undefined&&(typeof input.name!=='string'||input.name.length>100))||
      ['create','activate','vision','clearKey'].some(k=>input[k]!==undefined&&typeof input[k]!=='boolean')||
      (input.key!==undefined&&(typeof input.key!=='string'||input.key.length>4096)))throw fault('模型配置无效');
    const prior=input.create?{}:get(input.id),endpoint=input.endpoint.trim(),model=input.model.trim();
    if(!endpoint||!model)throw fault('请填写完整接口地址和模型名称');
    const id=input.create||prior.id==='environment'?randomUUID():prior.id;
    const value={id,name:input.name?.trim()||model,endpoint,model,key:input.clearKey?'':input.key||((endpoint===prior.endpoint)?prior.key||'':''),vision:input.vision===true};
    try {configuredWriter(toEnv(value));}catch {throw fault('接口地址须为 HTTPS 或本机 HTTP，不能包含凭证、查询参数或片段');}
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR REPLACE INTO model_profiles VALUES(?,?)').run(id,JSON.stringify(value));
      if(input.activate!==false||effective().id===id)db.prepare('INSERT OR REPLACE INTO model_settings VALUES(1,?)').run(JSON.stringify(value));
      db.exec('COMMIT');
    } catch(error){db.exec('ROLLBACK');throw error;}
    return {...view(),savedId:id};
  }
  function select(id) {
    if(typeof id!=='string'||!id)throw fault('请选择模型配置');
    const value=get(id);if(!value.endpoint||!value.model)throw fault('模型配置不完整');
    db.prepare('INSERT OR REPLACE INTO model_settings VALUES(1,?)').run(JSON.stringify(value));return view();
  }
  function toEnv(value) {return {MATRIX_MODEL_ENDPOINT:value.endpoint,MATRIX_MODEL_NAME:value.model,MATRIX_MODEL_KEY:value.key,MATRIX_MODEL_VISION:value.vision?'1':'0'};}
  function capture(id) {
    const value=get(id),config=toEnv(value);
    return {id:value.id,vision:value.vision,writer:configuredWriter(config),promptAgent:configuredPromptAgent(config),editor:configuredEditor(config),imageQueries:configuredImageQueries(config)};
  }
  async function test(id) {
    const value=get(id),probe=configuredProbe(toEnv(value)),start=Date.now();
    if(!probe)throw fault('请先保存完整模型配置');
    try {
      const result=await probe({instruction:'Return JSON with ok equal to true.'},{signal:AbortSignal.timeout(20000)});
      if(result?.ok!==true)throw Error('bad_response');
      return {ok:true,id:value.id,latencyMs:Date.now()-start,message:'连接成功，鉴权和结构化响应正常'};
    }catch {throw fault('模型测试失败：请检查地址、密钥、模型权限与 JSON 响应支持；请求超时为 20 秒',502);}
  }
  function callable(factory) {
    const invoke=(observation,options)=>{const model=factory(toEnv(effective()));if(!model)throw Error('missing_model');return model(observation,options);};
    Object.defineProperty(invoke,'available',{get:()=>view().configured});
    Object.defineProperty(invoke,'visionAvailable',{get:()=>view().configured&&effective().vision});return invoke;
  }
  return {view,save,select,test,capture,writer:callable(configuredWriter),planner:callable(configuredPlanner)};
}
