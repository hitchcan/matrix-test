import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
const script=fileURLToPath(new URL('../scripts/read-image-text.ps1',import.meta.url));

export async function readImageText(path,{signal}={}) {
  if(process.platform!=='win32')throw Object.assign(Error('本机未启用 Windows OCR'),{status:503,reasonCode:'ocr_unavailable'});
  let value;
  try {
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-AssetPath',path],
      {signal,windowsHide:true,timeout:45000,maxBuffer:256*1024,encoding:'utf8'});
    value=JSON.parse(stdout.trim());
  } catch {throw Object.assign(Error('本地图片解码或文字识别失败'),{status:422,reasonCode:'ocr_failed'});}
  if(value.error==='language_unavailable')throw Object.assign(Error('本机没有可用的 OCR 语言包'),{status:503,reasonCode:value.error});
  if(value.error==='image_too_large')throw Object.assign(Error('图片尺寸超过本地 OCR 限制'),{status:422,reasonCode:value.error});
  if(typeof value.text!=='string')throw Object.assign(Error('本地 OCR 结果无效'),{status:422,reasonCode:'ocr_failed'});
  return value;
}

export function imageTextStore({db,clock,recognize,pathFor,isClosed}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!db.prepare('SELECT 1 FROM schema_migrations WHERE version=12').get()) {
      db.exec(`CREATE TABLE asset_text(asset_id TEXT PRIMARY KEY,text TEXT NOT NULL,source TEXT NOT NULL,
        version INTEGER NOT NULL,language TEXT,width INTEGER,height INTEGER);
        CREATE TABLE run_asset_text(run_id TEXT NOT NULL,asset_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(run_id,asset_id));`);
      db.prepare('INSERT INTO schema_migrations VALUES(12,?)').run(clock());
    }
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  const pending=new Map(),controller=new AbortController();
  let tail=Promise.resolve();
  const get=id=>db.prepare('SELECT * FROM asset_text WHERE asset_id=?').get(id)??{asset_id:id,text:'',version:0,source:null};
  function assertImage(id) {
    if(!db.prepare("SELECT 1 FROM assets WHERE id=? AND mime LIKE 'image/%'").get(id))
      throw Object.assign(Error('未找到本地图片'),{status:404});
  }
  function analyze(id) {
    assertImage(id);
    const cached=get(id);
    if(cached.version)return Promise.resolve(cached);
    if(pending.has(id))return pending.get(id);
    const work=tail.then(async()=>{
      controller.signal.throwIfAborted();
      assertImage(id);
      const prior=get(id);
      if(prior.version)return prior;
      const result=await recognize(pathFor(id),{signal:controller.signal});
      if(isClosed())throw Error('closed');
      assertImage(id);
      db.prepare("INSERT OR IGNORE INTO asset_text VALUES(?,?,'windows_ocr',1,?,?,?)")
        .run(id,result.text.slice(0,12000),result.language,result.width,result.height);
      return get(id);
    }).finally(()=>pending.delete(id));
    pending.set(id,work);
    tail=work.catch(()=>{});
    return work;
  }
  function save(id,body) {
    assertImage(id);
    if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<0||typeof body.text!=='string'||body.text.length>12000)
      throw Object.assign(Error('图片文字或版本无效'),{status:422});
    const result=body.expectedVersion===0
      ? db.prepare("INSERT OR IGNORE INTO asset_text(asset_id,text,source,version) VALUES(?,?,'manual',1)").run(id,body.text)
      : db.prepare("UPDATE asset_text SET text=?,source='manual',version=version+1 WHERE asset_id=? AND version=?").run(body.text,id,body.expectedVersion);
    if(!result.changes)throw Object.assign(Error('图片文字已更新，请重新打开后编辑'),{status:409,reasonCode:'version_conflict'});
    return get(id);
  }
  return {get,analyze,save,assertImage,busy:id=>pending.has(id),close:()=>controller.abort()};
}
