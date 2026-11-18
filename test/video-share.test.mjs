import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {macroWorkflow} from '../workflow/macro-workflow.mjs';

function harness(t) {
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT);
    CREATE TABLE video_model_tasks(target_id TEXT PRIMARY KEY,status TEXT NOT NULL,remote_id TEXT,created_at TEXT NOT NULL,
      next_at TEXT NOT NULL,deadline TEXT NOT NULL,reserved_micros INTEGER NOT NULL,result_url TEXT,provider_key TEXT,profile_id TEXT,poll_failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,platform TEXT,mode TEXT,status TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,name TEXT,mime TEXT,size INTEGER,created TEXT);
    CREATE TABLE asset_sources(asset_id TEXT PRIMARY KEY,source TEXT);
    CREATE TABLE asset_notes(asset_id TEXT PRIMARY KEY,note TEXT);`);
  db.prepare("INSERT INTO accounts VALUES('a1','bilibili','browser','connected')").run();
  db.prepare("INSERT INTO accounts VALUES('a2','douyin','browser','connected')").run();
  const state={writes:0,videos:0,dispatched:[],ms:Date.parse('2026-11-17T00:00:00Z')};
  const generate=async()=>{state.writes++;return {title:'同一标题',body:'同一正文',assetIds:[],scenes:[{text:'镜头一'}],videoPrompt:'海边日落'};};
  generate.validate=()=>{};generate.callCount=()=>1;
  const macros=macroWorkflow({db,clock:()=>new Date(state.ms).toISOString(),writer:generate,
    imageText:{analyze:async()=>{throw Error('unused');}},
    makeCard:async()=>{throw Error('unused');},storeCard:()=>'card-1',
    makeVideo:async()=>{state.videos++;return {video:Buffer.from('ftyp'),cover:null,plan:null,duration:2,width:720,height:1280};},
    storeVideo:()=>'video-asset-'+state.videos,
    publicationSummary:()=>null,
    dispatch:req=>{state.dispatched.push(req);return {status:201,body:{id:'dispatch-'+state.dispatched.length}};},
    isClosed:()=>false,accountAvailable:()=>true,supportsTarget:()=>true});
  return {db,macros,state};
}
async function runTo(macros,state,count) {
  for(let i=0;i<400&&state.dispatched.length<count;i++){await macros.tick();await new Promise(r=>setTimeout(r,2));}
}

test('共用视频：多个账号只生成一条成片，发布同一文案与视频',async t=>{
  const {db,macros,state}=harness(t);
  const saved=macros.save({enabled:true,spec:{topic:'共用视频',style:'简短',facts:'事实',targets:[{accountId:'a1',type:'video'},{accountId:'a2',type:'video'}],assetIds:[],mode:'manual',maxCalls:4,shareVideo:true}});
  macros.runNow(saved.id,'share-run');
  await runTo(macros,state,2);
  assert.equal(state.dispatched.length,2);
  assert.equal(state.writes,1,'只应写一次文案');
  assert.equal(state.videos,1,'只应生成一条视频');
  const [first,second]=state.dispatched;
  assert.equal(first.content.generatedVideoId,'video-asset-1');
  assert.equal(second.content.generatedVideoId,'video-asset-1');
  assert.equal(first.content.title,second.content.title);
  assert.equal(first.content.body,second.content.body);
  assert.deepEqual([first.accountIds[0],second.accountIds[0]].sort(),['a1','a2']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_targets WHERE state='dispatched'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workflow_targets WHERE state='waiting_share'").get().n,0);
});

test('不勾选共用视频时每个账号各自生成一条',async t=>{
  const {macros,state}=harness(t);
  const saved=macros.save({enabled:true,spec:{topic:'独立视频',style:'简短',facts:'事实',targets:[{accountId:'a1',type:'video'},{accountId:'a2',type:'video'}],assetIds:[],mode:'manual',maxCalls:4}});
  macros.runNow(saved.id,'own-run');
  await runTo(macros,state,2);
  assert.equal(state.dispatched.length,2);
  assert.equal(state.videos,2);
  assert.notEqual(state.dispatched[0].content.generatedVideoId,state.dispatched[1].content.generatedVideoId);
});

test('共用视频只作用于视频目标，文章目标仍独立生成',async t=>{
  const {macros,state}=harness(t);
  const saved=macros.save({enabled:true,spec:{topic:'混合目标',style:'简短',facts:'事实',targets:[{accountId:'a1',type:'article'},{accountId:'a2',type:'video'},{accountId:'a1',type:'video'}],assetIds:[],mode:'manual',maxCalls:8,shareVideo:true}});
  macros.runNow(saved.id,'mixed-run');
  await runTo(macros,state,3);
  assert.equal(state.dispatched.length,3);
  assert.equal(state.videos,1);
  const videos=state.dispatched.filter(d=>d.content.type==='video');
  assert.equal(videos.length,2);
  assert.equal(videos[0].content.generatedVideoId,videos[1].content.generatedVideoId);
});
