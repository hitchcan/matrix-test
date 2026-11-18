import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {macroWorkflow} from '../workflow/macro-workflow.mjs';

const NOW=Date.parse('2026-11-17T12:00:00.000Z');
function harness(t,output){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);
    CREATE TABLE video_model_tasks(target_id TEXT PRIMARY KEY,status TEXT NOT NULL,remote_id TEXT,created_at TEXT NOT NULL,
      next_at TEXT NOT NULL,deadline TEXT NOT NULL,reserved_micros INTEGER NOT NULL,result_url TEXT,provider_key TEXT,profile_id TEXT,poll_failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,platform TEXT,mode TEXT,status TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,name TEXT,mime TEXT,size INTEGER,created TEXT);
    CREATE TABLE asset_sources(asset_id TEXT PRIMARY KEY,source TEXT);
    CREATE TABLE asset_notes(asset_id TEXT PRIMARY KEY,note TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,dispatch_id TEXT,state TEXT);`);
  db.prepare("INSERT INTO accounts VALUES('a1','bilibili','browser','connected')").run();
  const writer=async()=>output;
  writer.validate=()=>{};writer.callCount=()=>1;
  const macros=macroWorkflow({db,clock:()=>new Date(NOW).toISOString(),writer,
    imageText:{analyze:async()=>{throw Error('unused');}},makeCard:async()=>{throw Error('unused');},
    storeCard:()=>'card-1',
    makeVideo:async()=>({video:Buffer.from('ftyp'),cover:null,plan:null,duration:2,width:720,height:1280}),
    storeVideo:()=>'video-1',publicationSummary:()=>null,
    dispatch:()=>({status:201,body:{id:'dispatch-1'}}),isClosed:()=>false,
    accountAvailable:()=>true,supportsTarget:()=>true});
  const saved=macros.save({enabled:true,spec:{topic:'猫咪警告',style:'简短',facts:'事实',
    targets:[{accountId:'a1',type:'video'}],assetIds:[],mode:'manual',maxCalls:2}});
  const run=macros.runNow(saved.id,'run-'+Math.random());
  return {db,macros,runId:run.id};
}
async function drive(macros,runId){
  for(let i=0;i<200;i++){
    await macros.tick();
    const target=macros.details(runId).targets[0];
    if(target.state==='dispatched'||target.state==='blocked')return target;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw Error('等待生成超时');
}
const base={title:'猫',body:'正文',assetIds:[]};

test('稿件校验：场景文本超长时截断而不是阻断',async t=>{
  const {macros,runId}=harness(t,{...base,scenes:[{text:'猫'.repeat(400)}],videoPrompt:'提示词'});
  const target=await drive(macros,runId);
  assert.equal(target.state,'dispatched');
  assert.equal(target.artifact.scenes[0].text.length,300);
});

test('稿件校验：场景超过 16 个时保留前 16 个',async t=>{
  const scenes=Array.from({length:20},(_,i)=>({text:'镜头'+(i+1)}));
  const {macros,runId}=harness(t,{...base,scenes,videoPrompt:'提示词'});
  const target=await drive(macros,runId);
  assert.equal(target.state,'dispatched');
  assert.equal(target.artifact.scenes.length,16);
});

test('稿件校验：场景里不存在的素材 ID 被丢弃而不是阻断',async t=>{
  const {macros,runId}=harness(t,{...base,scenes:[{assetId:'ghost-asset',text:'镜头'}],videoPrompt:'提示词'});
  const target=await drive(macros,runId);
  assert.equal(target.state,'dispatched');
  assert.equal(target.artifact.scenes[0].assetId,undefined);
  assert.deepEqual(target.artifact.sourceAssetIds,[]);
});

test('稿件校验：标题超长时截断到 1000 字',async t=>{
  const {macros,runId}=harness(t,{...base,title:'题'.repeat(1200),scenes:[{text:'镜头'}],videoPrompt:'提示词'});
  const target=await drive(macros,runId);
  assert.equal(target.state,'dispatched');
  assert.equal(target.artifact.title.length,1000);
});

test('稿件校验：视频提示词为空时用场景文本拼合',async t=>{
  const {macros,runId}=harness(t,{...base,scenes:[{text:'镜头一'},{text:'镜头二'}],videoPrompt:''});
  const target=await drive(macros,runId);
  assert.equal(target.state,'dispatched');
  assert.equal(target.artifact.videoPrompt,'镜头一\n镜头二');
});

test('稿件校验：缺少标题或场景仍然阻断并保留具体原因',async t=>{
  const emptyTitle=harness(t,{...base,title:'  ',scenes:[{text:'镜头'}],videoPrompt:'提示词'});
  const blocked=await drive(emptyTitle.macros,emptyTitle.runId);
  assert.equal(blocked.state,'blocked');
  assert.equal(blocked.reason,'invalid_artifact');

  const noScenes=harness(t,{...base,scenes:[],videoPrompt:'提示词'});
  const blocked2=await drive(noScenes.macros,noScenes.runId);
  assert.equal(blocked2.state,'blocked');
  assert.equal(blocked2.reason,'invalid_artifact');
});
