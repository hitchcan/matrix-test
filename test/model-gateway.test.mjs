import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {modelSettings} from '../workflow/model-settings.mjs';
import {configuredWriter} from '../workflow/model-gateway.mjs';
import {sourceMedia} from '../workflow/source-media.mjs';
import {existsSync} from 'node:fs';

test('授权 MP4 的开头、中段、后段画面可供 LLM 生成参考，不读取音频',async t=>{
  const path=process.env.MATRIX_TEST_VIDEO||'E:/矩阵调研2/抖音测试视频/Dota 2 2026-04-09 11-20-13.mp4';
  if(!existsSync(path)){t.skip('未提供授权测试 MP4');return;}
  const result=await sourceMedia([{id:'authorized-video',name:'授权测试视频',mime:'video/mp4'}],()=>path,AbortSignal.timeout(30000));
  assert.equal(result[0].previews.length,3);assert.equal(result[0].previews[0].at,0);
  assert.ok(result[0].previews[2].at>result[0].previews[1].at);
  assert.ok(result[0].previews.every(p=>p.url.startsWith('data:image/jpeg;base64,')));
});

test('用户模型配置持久化、隐藏密钥、留空保留与变更地址隔离',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const settings=modelSettings(db,{});assert.equal(settings.writer.available,false);
    settings.save({endpoint:'https://example.com/chat/completions',model:'first',key:'private-key',vision:true});
    assert.equal(settings.writer.available,true);assert.equal(settings.view().vision,true);
    assert.ok(!JSON.stringify(settings.view()).includes('private-key'));
    const reopened=modelSettings(db,{});assert.equal(reopened.view().hasKey,true);
    reopened.save({endpoint:'https://example.com/chat/completions',model:'second',key:''});
    assert.equal(reopened.view().hasKey,true);
    reopened.save({endpoint:'https://another.example/chat/completions',model:'third',key:''});
    assert.equal(reopened.view().hasKey,false);
    assert.throws(()=>settings.save({endpoint:'http://example.com/chat',model:'bad'}),/HTTPS/);
    assert.throws(()=>settings.save({endpoint:'https://example.com/?key=secret',model:'bad'}),/HTTPS/);
  } finally {db.close();}
});

test('视觉网关发送所选画面与素材标识，普通模型拒绝静默丢弃画面',async()=>{
  let body;const env={MATRIX_MODEL_ENDPOINT:'https://example.com/chat',MATRIX_MODEL_NAME:'vision',MATRIX_MODEL_VISION:'1'};
  const request=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"title":"稿件"}'}}]})};};
  const input={topic:'素材写作',assets:[{id:'selected',mime:'video/mp4',previews:[{at:5,url:'data:image/jpeg;base64,abc'}]}]};
  await configuredWriter(env,request)(input,{});
  const content=body.messages[1].content;
  assert.equal(content[2].image_url.url,'data:image/jpeg;base64,abc');assert.match(content[1].text,/selected.*5/);
  assert.ok(!content[0].text.includes('data:image'));
  await assert.rejects(configuredWriter({...env,MATRIX_MODEL_VISION:'0'},request)(input,{}),/vision_required/);
});
import http from 'node:http';
import {configuredPlanner} from '../workflow/model-gateway.mjs';

test('视觉规划网关把截图作为图片输入，正文只包含脱敏能力且普通模型拒绝截图',async()=>{
  let body;const env={MATRIX_MODEL_ENDPOINT:'https://example.com/chat',MATRIX_MODEL_NAME:'visual-agent',MATRIX_MODEL_VISION:'1'};
  const request=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"action":"click","token":"nonce","targetId":"v0"}'}}]})};};
  const observation={token:'nonce',mode:'visual',actions:['click'],targets:[{id:'v0',label:'关闭'}],screenshot:'data:image/png;base64,test'};
  const result=await configuredPlanner(env,request)(observation,{});assert.equal(result.targetId,'v0');
  assert.equal(body.messages[1].content[1].image_url.url,observation.screenshot);assert.ok(!body.messages[1].content[0].text.includes('base64'));
  await assert.rejects(configuredPlanner({...env,MATRIX_MODEL_VISION:'0'},request)(observation,{}),/vision_required/);
});

test('视觉规划网关传递可信目标和CSS像素坐标协议，不要求固定targetId',async()=>{
  let body;const request=async(u,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"action":"click_at","token":"nonce","goal":"visibility","x":120,"y":200}'}}]})};};
  const {configuredPlanner}=await import('../workflow/model-gateway.mjs');
  const result=await configuredPlanner({MATRIX_MODEL_ENDPOINT:'https://model.example/chat',MATRIX_MODEL_NAME:'vision',MATRIX_MODEL_VISION:'1'},request)({token:'nonce',mode:'visual',coordinateMode:true,goal:{kind:'visibility',desired:'仅自己可见'},viewport:{width:900,height:700},actions:['click_at'],screenshot:'data:image/png;base64,AA=='},{});
  assert.equal(result.x,120);assert.match(body.messages[0].content,/CSS pixel/);assert.ok(JSON.stringify(body.messages[1].content).includes('仅自己可见'));
});

test('旧单模型配置迁移为命名配置，切换与编辑不会覆盖其他模型',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE model_settings(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO model_settings VALUES(1,?)').run(JSON.stringify({endpoint:'https://example.com/chat',model:'old',key:'legacy-private',vision:true}));
    const settings=modelSettings(db,{}),legacy=settings.view().activeId;
    assert.equal(settings.view().profiles.length,1);assert.equal(settings.view().profiles[0].hasKey,true);
    const second=settings.save({create:true,activate:false,name:'写作',endpoint:'https://other.example/chat',model:'writer',key:'writer-private'});
    assert.equal(second.activeId,legacy);assert.equal(second.profiles.length,2);
    settings.select(second.savedId);assert.equal(settings.view().model,'writer');
    settings.save({id:legacy,activate:false,endpoint:'https://example.com/chat',model:'old-new',key:''});
    assert.equal(settings.view().model,'writer');settings.select(legacy);assert.equal(settings.view().model,'old-new');assert.equal(settings.view().hasKey,true);
    assert.ok(!JSON.stringify(settings.view()).includes('private'));
    assert.equal(modelSettings(db,{}).view().profiles.length,2);
  } finally {db.close();}
});

test('连接测试发送最短 JSON 请求，失败不泄露供应商正文或密钥',async t=>{
  let reject=false,calls=0;
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);assert.equal(body.max_tokens,32);assert.ok(!text.includes('任务事实'));calls++;
    res.setHeader('Content-Type','application/json');res.statusCode=reject?401:200;
    res.end(reject?'private-provider-error':JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const settings=modelSettings(db,{});
  const saved=settings.save({endpoint:'http://127.0.0.1:'+server.address().port+'/chat',model:'probe',key:'secret'});
  assert.equal((await settings.test(saved.savedId)).ok,true);reject=true;
  await assert.rejects(settings.test(saved.savedId),e=>e.status===502&&!e.message.includes('private-provider-error')&&!e.message.includes('secret'));
  assert.equal(calls,2);
});

test('模型网关使用配置的 HTTP 服务、鉴权和结构化响应',async t=>{
  let received;
  const server=http.createServer(async(req,res)=>{
    let input='';
    for await(const chunk of req) input+=chunk;
    received={body:JSON.parse(input),auth:req.headers.authorization};
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'{"action":"revalidate","token":"local"}'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const model=configuredPlanner({MATRIX_MODEL_ENDPOINT:'http://127.0.0.1:'+server.address().port+'/chat/completions',MATRIX_MODEL_NAME:'local-test',MATRIX_MODEL_KEY:'test-key'});
  const observation={token:'local',actions:['revalidate','human']};
  assert.deepEqual(await model(observation,{signal:AbortSignal.timeout(2000)}),{action:'revalidate',token:'local'});
  assert.equal(received.auth,'Bearer test-key');
  assert.equal(received.body.model,'local-test');
  assert.deepEqual(JSON.parse(received.body.messages[1].content),observation);
  assert.equal(configuredPlanner({}),null);
});

test('万相 3.0 适配异步头、官方请求结构和任务查询，模型配置可替换',async()=>{
  const {configuredVideoProvider}=await import('../workflow/video-model.mjs');
  const calls=[];
  const request=async(url,options)=>{
    calls.push({url:String(url),options});
    return {ok:true,json:async()=>options.method==='POST'?{output:{task_id:'wan-task'}}:{output:{task_status:'SUCCEEDED',video_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.mp4'}}};
  };
  const provider=configuredVideoProvider({MATRIX_VIDEO_ENDPOINT:'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',MATRIX_VIDEO_KEY:'test-only'},request);
  assert.deepEqual(await provider.create({prompt:'一个场景',aspect_ratio:'9:16'},'intent',AbortSignal.timeout(2000)),{id:'wan-task'});
  assert.equal(calls[0].options.headers['X-DashScope-Async'],'enable');
  const body=JSON.parse(calls[0].options.body);
  assert.equal(body.model,'wan3.0-video');assert.deepEqual(body.input,{prompt:'一个场景'});
  assert.equal(body.parameters.ratio,'9:16');assert.equal(body.parameters.duration,5);
  assert.equal((await provider.check('wan-task',AbortSignal.timeout(2000))).status,'succeeded');
  assert.equal(calls[1].url,'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/tasks/wan-task');
  const changed=configuredVideoProvider({MATRIX_VIDEO_ENDPOINT:'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',MATRIX_VIDEO_MODEL:'other-video-model'},request);
  assert.notEqual(provider.identity,changed.identity);
});
