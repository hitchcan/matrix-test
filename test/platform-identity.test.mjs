import test from 'node:test';
import assert from 'node:assert/strict';
import {watchKuaishouIdentity} from '../kuaishou-identity.mjs';
import {watchChannelsIdentity,channelsDocumentIdentity} from '../wechat-channels.mjs';

function fakePage() {
  const handlers=[];
  return {
    on:(event,cb)=>{if(event==='response')handlers.push(cb);},
    async respond(url,json,status=200){for(const cb of handlers)await cb({url:()=>url,status:()=>status,json:async()=>json});}
  };
}
function fakeDocumentPage(ids){
  return {isClosed:()=>false,url:()=>'https://channels.weixin.qq.com/platform',mainFrame:()=>({}),frames:()=>[],evaluate:async()=>({ids,text:'',keys:[]})};
}

test('快手身份：官方账号接口带缓存参数也能识别',async()=>{
  const page=fakePage(),read=watchKuaishouIdentity(page);
  await page.respond('https://cp.kuaishou.com/rest/v2/creator/pc/authority/account/current?__NS_sig=abc',{result:1,data:{logined:true,userId:123456789,userKwaiId:'kuaishou_abc',userName:'老吴'}});
  const identity=read(Date.now()-5000);
  assert.equal(identity.platformId,'123456789');
  assert.deepEqual(identity.aliases,['123456789','kuaishou_abc']);
  assert.equal(identity.displayName,'老吴');
});

test('快手身份：未登录标记与非账号接口都不采信',async()=>{
  const page=fakePage(),read=watchKuaishouIdentity(page);
  await page.respond('https://cp.kuaishou.com/rest/v2/creator/pc/authority/account/current',{result:1,data:{logined:false,userId:111111}});
  assert.equal(read(0),null);
  await page.respond('https://cp.kuaishou.com/rest/v2/feed/list',{result:1,data:{userId:999999,userKwaiId:'other'}});
  assert.equal(read(0),null);
});

test('视频号身份：auth_data 带查询参数也能识别',async()=>{
  const page=fakePage(),read=watchChannelsIdentity(page);
  await page.respond('https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data?t=1712',{errCode:0,data:{finderUser:{finderUsername:'sphABC123',nickname:'视频号测试'}}});
  const identity=read(Date.now()-5000);
  assert.equal(identity.platformId,'sphABC123');
  assert.equal(identity.displayName,'视频号测试');
});

test('视频号身份：内容接口里的其他作者不被误认为本人',async()=>{
  const page=fakePage(),read=watchChannelsIdentity(page);
  await page.respond('https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/post/get_feed',{errCode:0,data:{finderUser:{finderUsername:'someone_else'}}});
  await page.respond('https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/other/foreign.example',{errCode:0,data:{finderUser:{finderUsername:'x'}}});
  assert.equal(read(0),null);
});

test('视频号身份：错误码响应被忽略',async()=>{
  const page=fakePage(),read=watchChannelsIdentity(page);
  await page.respond('https://channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/auth/auth_data',{errCode:10001,data:{finderUser:{finderUsername:'sphBAD'}}});
  assert.equal(read(0),null);
});

test('视频号身份：/micro/content 前缀的账号接口也能识别',async()=>{
  const page=fakePage(),read=watchChannelsIdentity(page);
  await page.respond('https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/account/get_account_info?_aid=x',{errCode:0,data:{finderUser:{finderUsername:'sphMICRO',nickname:'微前端'}}});
  assert.equal(read(Date.now()-5000).platformId,'sphMICRO');
});

test('视频号身份：页面内嵌的本人ID可作兜底，多个不同ID不采信',async()=>{
  assert.equal((await channelsDocumentIdentity(fakeDocumentPage(['sphEmbedded']))).platformId,'sphEmbedded');
  assert.equal(await channelsDocumentIdentity(fakeDocumentPage(['sphA','sphB'])),null);
  assert.equal(await channelsDocumentIdentity(fakeDocumentPage([])),null);
});

test('视频号身份：内容列表只有一个作者时可确认本人，出现多个作者不采信',async()=>{
  const single=fakePage(),readSingle=watchChannelsIdentity(single);
  await single.respond('https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?_aid=x',{errCode:0,data:{objectList:[{objectDesc:{finderUser:{finderUsername:'sphOWN'}}},{objectDesc:{finderUser:{finderUsername:'sphOWN'}}}]}});
  assert.equal(readSingle(Date.now()-5000).platformId,'sphOWN');

  const mixed=fakePage(),readMixed=watchChannelsIdentity(mixed);
  await mixed.respond('https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?_aid=x',{errCode:0,data:{objectList:[{finderUser:{finderUsername:'sphOWN'}},{finderUser:{finderUsername:'someone_else'}}]}});
  assert.equal(readMixed(Date.now()-5000),null);
});
