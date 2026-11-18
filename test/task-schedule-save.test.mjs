import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {macroWorkflow} from '../workflow/macro-workflow.mjs';

// 香港时间 2026-11-17 16:16
const NOW=Date.parse('2026-11-17T08:16:00.000Z');
const baseSpec={topic:'定时回归',style:'简短',facts:'事实',targets:[{accountId:'a1',type:'article'}],assetIds:[],mode:'manual',maxCalls:1};

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
  const unused=async()=>{throw Error('不应被调用');};
  const macros=macroWorkflow({db,clock:()=>new Date(NOW).toISOString(),writer:unused,imageText:{analyze:unused},
    makeCard:unused,storeCard:()=>'',makeVideo:unused,storeVideo:()=>'',publicationSummary:()=>null,
    dispatch:()=>({status:500}),isClosed:()=>false,accountAvailable:()=>true,supportsTarget:()=>true});
  const template=id=>macros.templates().find(t=>t.id===id);
  return {db,macros,template};
}
const schedule=extra=>({kind:'daily',startAt:'2026-11-01T01:00:00.000Z',endAt:'2026-11-30T15:59:00.000Z',times:['15:40'],latePolicy:'latest',...extra});

test('保存开始日期在过去的每日模板时，等待下一个真实时段而不是立刻补发',async t=>{
  const {macros,template}=harness(t);
  const saved=macros.save({enabled:true,spec:{...baseSpec,schedule:schedule()}});
  assert.equal(template(saved.id).next_at,'2026-11-18T07:40:00.000Z','应为明天 15:40（香港）');
  await macros.tick();
  assert.equal(macros.runs().length,0,'保存后不应立刻产生运行');
});

test('修改定时设置同样从未来时段起算',async t=>{
  const {macros,template}=harness(t);
  const saved=macros.save({enabled:true,spec:{...baseSpec,schedule:schedule({times:['09:00']})}});
  await macros.tick();
  assert.equal(macros.runs().length,0);
  const prior=template(saved.id);
  macros.save({enabled:true,expectedVersion:prior.version,spec:{...baseSpec,schedule:schedule({times:['20:00']})}},saved.id,true);
  const updated=template(saved.id);
  assert.equal(updated.version,prior.version+1);
  assert.equal(updated.next_at,'2026-11-17T12:00:00.000Z','应为今天 20:00（香港）');
  await macros.tick();
  assert.equal(macros.runs().length,0);
});

test('全部时段已过去的模板保存后不再自动触发',async t=>{
  const {macros,template}=harness(t);
  const saved=macros.save({enabled:true,spec:{...baseSpec,schedule:{kind:'once',startAt:'2026-11-01T01:00:00.000Z'}}});
  assert.equal(template(saved.id).next_at,null);
  await macros.tick();
  assert.equal(macros.runs().length,0);
});

test('未来开始的定时模板仍按原时间排队',async t=>{
  const {macros,template}=harness(t);
  const saved=macros.save({enabled:true,spec:{...baseSpec,schedule:schedule({startAt:'2026-11-20T01:00:00.000Z'})}});
  assert.equal(template(saved.id).next_at,'2026-11-20T07:40:00.000Z');
});

test('只改内容不改定时不会重置下次运行时间',async t=>{
  const {macros,template}=harness(t);
  const saved=macros.save({enabled:true,spec:{...baseSpec,schedule:schedule()}});
  const prior=template(saved.id);
  macros.save({enabled:true,expectedVersion:prior.version,spec:{...baseSpec,topic:'改了主题',schedule:schedule()}},saved.id,true);
  assert.equal(template(saved.id).next_at,prior.next_at);
});
