import test from 'node:test';
import assert from 'node:assert/strict';
import {operationPacer} from '../browser-pace.mjs';
const page={isClosed:()=>false};

test('随机阶段间隔有边界，上传及提交前使用较长间隔',async()=>{
  const ranges=[],pacer=operationPacer({minMs:1,maxMs:3,random:(min,max)=>{ranges.push([min,max]);return max-1;}});
  try {
    assert.equal(await pacer.wait(page,'field'),3);
    assert.equal(await pacer.wait(page,'upload'),6);assert.equal(await pacer.wait(page,'submit'),6);
    assert.deepEqual(ranges,[[1,4],[2,7],[2,7]]);
    assert.throws(()=>operationPacer({minMs:20,maxMs:10}),/操作节奏参数/);
    assert.throws(()=>operationPacer({maxMs:10001}),/操作节奏参数/);
  }finally{pacer.close();}
});

test('停止任务、关闭页面及退出运行时能取消尚未完成的长等待',async()=>{
  for(const reason of ['stop','page','close']) {
    let active=true,closed=false;const pacer=operationPacer({minMs:5000,maxMs:5000}),started=performance.now();
    const pending=pacer.wait({isClosed:()=>closed},'field',{isActive:()=>active});
    if(reason==='stop')active=false;else if(reason==='page')closed=true;else pacer.close();
    await assert.rejects(pending,e=>e.code==='operation_cancelled');assert.ok(performance.now()-started<4000);
    pacer.close();
  }
});

test('关闭节奏等待仍检查任务控制权，不能靠禁用延迟执行已停止的动作',async()=>{
  const pacer=operationPacer({enabled:false});
  assert.equal(await pacer.wait(page,'field'),0);
  await assert.rejects(pacer.wait(page,'field',{isActive:()=>false}),e=>e.code==='operation_cancelled');pacer.close();
});
