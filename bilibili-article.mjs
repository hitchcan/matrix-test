import {pasteArticleImages} from './article-images.mjs';
const fail=message=>Object.assign(Error('B站长文章：'+message),{state:'needs_manual',status:409});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function bilibiliArticleEditorUrl(href) {
  const u=new URL(href);return u.protocol==='https:'&&u.hostname==='member.bilibili.com'&&u.pathname==='/york/read-editor';
}
export function pasteBilibiliArticleImages(field,html,options={}) {
  return pasteArticleImages(field,html,{...options,isEditor:bilibiliArticleEditorUrl,imageHosts:['hdslb.com','biliimg.com'],label:'B站长文章'});
}
export async function bilibiliArticleField(page,kind,rule) {
  const field=page.locator(rule[kind]).filter({visible:true});
  await field.first().waitFor({state:'visible',timeout:rule.readyTimeoutMs||60000});
  if(await field.count()!==1)throw fail('标题或正文编辑器不唯一，已暂停。');
  return field;
}
export async function bilibiliArticleSettings(page) {
  if(!bilibiliArticleEditorUrl(page.url()))throw fail('专栏编辑页已切换，未提交。');
  const settings=page.locator('.publish-settings').filter({visible:true});
  if(await settings.count()!==1)throw fail('未找到唯一的发布设置，请确认已进入新版专栏编辑器。');
  await settings.scrollIntoViewIfNeeded();return settings;
}
export async function bilibiliArticleAi(page,wanted,{required=true}={}) {
  if(wanted===null)return {state:'unchanged',checked:null};
  const settings=await bilibiliArticleSettings(page);
  const item=settings.locator('.creation-declaration .declaration-item').filter({hasText:/AI\s*辅助创作声明/});
  if(await item.count()===0) {
    if(wanted===false)return {state:'not_requested',checked:null,kind:'bilibili-article-no-ai'};
    if(!required)return {state:'pending',checked:null,evidence:'B站长文章未显示 AI 辅助创作声明，提交前需确认。'};
    throw fail('未显示 AI 辅助创作声明，不能替换成原创声明或跳过声明发布。');
  }
  const input=item.locator('input[type=checkbox]');
  if(await item.count()!==1||await input.count()!==1)throw fail('AI 辅助创作声明控件不唯一。');
  if(await input.isChecked()!==wanted) {
    if(await input.isDisabled())throw fail('AI 辅助创作声明不可操作。');
    const label=input.locator('xpath=ancestor::label[1]');
    if(await label.count()!==1)throw fail('AI 声明缺少唯一可点击标签。');
    await label.click({timeout:5000});
  }
  if(await input.isChecked()!==wanted)throw fail('AI 声明未读回一致状态，未提交。');
  return {state:'applied',checked:wanted,kind:'bilibili-article-ai',evidence:'已核对B站长文章 AI 辅助创作声明；未改动原创声明。'};
}
export async function requireBilibiliArticleReady(page) {
  const settings=await bilibiliArticleSettings(page);
  const field=label=>settings.locator('.form-item').filter({has:page.locator('.form-item-label').filter({hasText:new RegExp('^'+label+'$')})});
  for(const label of ['定时发布','自定义封面']) {
    const row=field(label);if(await row.count()>1)throw fail(label+'设置不唯一。');
    const control=row.locator('input[type=checkbox]');
    if(await control.count()>1)throw fail(label+'控件不唯一。');
    if(await control.count()===1&&await control.isChecked()) {
      if(label==='定时发布')throw fail('当前已开启平台定时发布，请在原页确认时间或关闭；工具不改写平台发布时间。');
      const images=row.locator('.select-cover img');
      if(await images.count()!==1||!await images.evaluateAll(ns=>ns.every(n=>n.complete&&n.naturalWidth>0&&/^https:\/\//.test(n.currentSrc||n.src))))throw fail('自定义封面未上传完成，请在原页补齐，或关闭自定义封面使用平台自动文字封面。');
    }
  }
  if(await page.locator('.editor-container .eva3-loading:visible,.editor-container .eva3-error:visible').count())throw fail('正文图片仍在上传或上传失败，未提交。');
}
export async function bilibiliArticlePublishButton(page,rule) {
  await requireBilibiliArticleReady(page);
  const button=page.locator('.publish-footer .footer-right').getByRole('button',{name:'发布',exact:true}).filter({visible:true});
  if(await button.count()!==1)throw fail('最终发布按钮不唯一，未点击任何发布控件。');
  if(!await button.isEnabled())throw fail('发布按钮不可用，请检查账号权限、实名认证或页面提示。');
  return button;
}
export async function bilibiliArticleSuccessVisible(page) {
  return page.locator('.publish-success-dialog .success-text').filter({hasText:/^你的专栏已提交成功$/}).filter({visible:true}).count().then(count=>count===1);
}
export async function bilibiliArticleReceipt(page,rule) {
  const end=Date.now()+(rule.resultTimeoutMs||45000);
  do {
    if(await bilibiliArticleSuccessVisible(page))return {simulated:false,id:null,url:null,submittedAt:new Date().toISOString(),evidence:'B站新版专栏编辑器显示“你的专栏已提交成功”；作品ID、审核和公开状态仍待核验'};
    if(await page.locator('[role=alert],.vui_toast,.vui-toast').filter({hasText:/发布失败|提交失败|网络错误|实名认证|绑定手机|验证码|频繁|状态异常/}).filter({visible:true}).count())throw fail('最终提交后出现错误或验证提示，结果待核对，禁止重复提交。');
    await wait(200);
  }while(Date.now()<end);
  throw fail('最终点击后未取得明确提交回执，请核对创作中心，禁止重复发布。');
}
