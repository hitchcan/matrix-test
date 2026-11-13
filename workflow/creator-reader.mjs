import {createHash} from 'node:crypto';
import {routes} from '../browser-runtime.mjs';
import {observeRecovery} from './recovery-page.mjs';
import {observeVisualRecovery} from './visual-recovery.mjs';
import { requiredViews } from './retry-evidence.mjs';
const defaults = { '已发布':'found_published', '审核中':'found_reviewing', '定时发布':'found_scheduled',
  '草稿':'found_draft', '审核未通过':'found_rejected' };
const normalize = text => String(text ?? '').normalize('NFC').replace(/\s+/gu,' ').trim();

// Selectors describe the operator's observed creator-center layout. A positive match
// needs a complete baseline and a stable ID, title, full body, type and timestamp.
export function creatorReader(runtime,platform,rules) {
  const hosts=routes[platform]?.origins;
  if (!hosts) throw Error('unsupported_platform');
  const origin=new URL(rules.url).origin;
  if(!hosts.some(host=>origin==='https://'+host)) throw Error('invalid_origin');
  const nonempty=v=>typeof v==='string' && !!v.trim();
  if(![rules.complete,rules.row,rules.title,rules.body,rules.time,rules.type,rules.status].every(nonempty) ||
      (!nonempty(rules.idAttribute) && !nonempty(rules.link)) ||
      !rules.types || !Object.values(rules.types).length || !Object.values(rules.types).every(nonempty))
    throw Error('invalid_list_rules');
  if(rules.detail && ![rules.link,rules.detail.title,rules.detail.body].every(nonempty)) throw Error('invalid_detail_rules');
  if(rules.views) {
    const urls=new Set(),markers=new Set();
    for(const name of requiredViews) {
      const view=rules.views[name];
      if(!view || ![view.url,view.active,view.next,view.end,view.empty].every(nonempty)) throw Error('invalid_view_rules');
      const url=new URL(view.url);
      if(url.origin!==origin || url.username || url.password || urls.has(url.href) || markers.has(view.active))
        throw Error('invalid_view_scope');
      urls.add(url.href);markers.add(view.active);
    }
    if(!Number.isInteger(rules.maxPages) || rules.maxPages<1 || rules.maxPages>100) throw Error('page_budget');
  }
  const statuses={...defaults,...rules.statuses};
  const allowed=new Set(Object.values(defaults));
  if(Object.values(statuses).some(status=>!allowed.has(status))) throw Error('invalid_status_mapping');
  const signature=createHash('sha256').update(JSON.stringify([platform,rules])).digest('hex');
  const pages = new WeakMap();
  async function read(account) {
    const url = new URL(rules.url);
    if (url.origin !== origin || url.username || url.password) throw Error('invalid_origin');
    const identity = await runtime.check(account,true);
    if (!account.platform_id || identity.platformId !== account.platform_id) throw Error('identity_mismatch');
    const session = await runtime.open(account,false,false);
    let page = pages.get(session.context);
    if (!page || page.isClosed()) {
      page = await session.context.newPage();
      pages.set(session.context,page);
    }
    const owns = () => pages.get(session.context)===page && !page.isClosed();
    const recoveryPage = {
      observeVisual:async()=>{
        if(!owns())return {human:true};
        const snapshot=await observeVisualRecovery(page,[url.hostname]);
        if(!snapshot.human){const perform=snapshot.perform;snapshot.perform=action=>owns()&&perform(action);}
        return snapshot;
      },
      observe:async()=>{
        if (!owns()) return {human:true};
        const snapshot=await observeRecovery(page,[url.hostname]);
        if (!snapshot.human) {
          const perform=snapshot.perform;
          snapshot.perform=action=>owns() && perform(action);
        }
        return snapshot;
      },
      reveal:()=>owns() && runtime.reveal(account,page)
    };
    async function readPage(target) {
      if (target.origin !== url.origin || target.username || target.password) throw Error('invalid_origin');
      await runtime.pace?.(page,'navigate');
      await page.goto(target.href,{waitUntil:'domcontentloaded'});
      const finalUrl = new URL(page.url());
      if (finalUrl.href !== target.href) throw Object.assign(Error('unexpected_page'),{recoveryPage});
      const snapshot=await recoveryPage.observe();
      try {
        if (snapshot.human || snapshot.observation.actions.includes('dismiss_tip')) {
          throw Object.assign(Error('view_blocked'),{recoveryPage});
        }
      } finally {await snapshot.dispose?.();}
      try {
        await page.locator(rules.complete).waitFor({state:'visible',timeout:5000});
      } catch {
        throw Object.assign(Error('list_not_ready'),{recoveryPage});
      }
      const batch=await page.locator(rules.row).evaluateAll((nodes,r) => nodes.map(row => {
        const read = selector => row.querySelector(selector)?.textContent?.trim() ?? '';
        return {id:r.idAttribute ? row.getAttribute(r.idAttribute) : null,link:r.link ? row.querySelector(r.link)?.href : null,title:read(r.title), body:read(r.body),
          type:read(r.type),time:row.querySelector(r.time)?.getAttribute('datetime'),status:read(r.status)};
      }),rules);
      for(const row of batch) {
        const linked=row.link && workId(platform,row.link);
        if(row.id && linked && row.id!==linked) throw Error('conflicting_work_id');
        if(!row.id) row.id=linked;
        // Rebuild the canonical read-only URL without query parameters or tracking fragments.
        row.link=linked ? new URL(row.link).origin+new URL(row.link).pathname : null;
      }
      return batch;
    }
    if (!rules.views) {
      const rows=await readPage(url);
      if ((await runtime.check(account,true)).platformId!==account.platform_id) throw Error('identity_mismatch');
      return {rows};
    }
    const rows = new Map();
    let pagesVisited = 0;
    const maxPages = rules.maxPages;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('page_budget');
    for (const view of requiredViews) {
      const spec = rules.views[view];
      let target = new URL(spec.url);
      const seen = new Set();
      while (true) {
        if (seen.has(target.href) || seen.size >= maxPages) throw Error('coverage_incomplete');
        seen.add(target.href);
        const batch = await readPage(target);
        if (!await page.locator(spec.active).isVisible()) throw Object.assign(Error('wrong_view'),{recoveryPage});
        if ((!batch.length) !== await page.locator(spec.empty).isVisible()) throw Object.assign(Error('blank_list'),{recoveryPage});
        for (const row of batch) {
          if (!row.id || !row.title || !row.type || !Object.hasOwn(statuses,row.status) ||
              !/(Z|[+-]\d{2}:\d{2})$/.test(row.time) || !Number.isFinite(Date.parse(row.time))) throw Error('incomplete_row');
          if(statuses[row.status]!=='found_'+view) throw Error('conflicting_view_status');
          const prior = rows.get(row.id);
          if (prior && JSON.stringify(prior)!==JSON.stringify(row)) throw Error('unstable_results');
          rows.set(row.id,row);
        }
        pagesVisited++;
        const next = page.locator(spec.next);
        if (await page.locator(spec.end).isVisible()) {
          if (await next.isVisible()) throw Error('conflicting_pagination');
          break;
        }
        if (!await next.isVisible()) throw Error('incomplete_page');
        const href = await next.getAttribute('href');
        if (!href) throw Error('missing_page');
        target = new URL(href,target);
      }
    }
    if ((await runtime.check(account,true)).platformId !== account.platform_id) throw Error('identity_mismatch');
    return {rows:[...rows.values()],coverage:{complete:true,pagesVisited,statusesChecked:requiredViews}};
  }
  return {
    async reveal(account) {
      const session=await runtime.open(account,false,false);
      let page=pages.get(session.context);
      if (!page || page.isClosed()) {
        const url=new URL(rules.url);
        if (url.origin!==origin || url.username || url.password) throw Error('invalid_origin');
        page=await session.context.newPage();
        pages.set(session.context,page);
        await page.goto(url.href,{waitUntil:'domcontentloaded'});
      }
      await runtime.reveal(account,page);
    },
    async baseline(account) {
      const {rows,coverage} = await read(account);
      if (rows.some(r => !r.id)) throw Error('incomplete_baseline');
      return {platform,signature,account:account.platform_id,ids:rows.map(r=>r.id),complete:!!coverage};
    },
    async verify({account,baseline,content,attempts,receiptIds=[]}) {
      const unknown = {result:'inconclusive'};
      if (!account.platform_id || !attempts.length || (account.platform && account.platform!==platform)) return unknown;
      const validBaseline=baseline?.account===account.platform_id && baseline.platform===platform && baseline.signature===signature;
      if(!validBaseline && !receiptIds.length) return unknown;
      const {rows,coverage} = await read(account);
      const accountIdentity={verified:true,observed:account.platform_id};
      if(receiptIds.length) {
        const found=rows.filter(r=>receiptIds.includes(r.id) && r.type===rules.types[content.type]);
        const ids=new Set(found.map(r=>r.id));
        if(ids.size>1) return {result:'duplicate_suspected',accountIdentity};
        if(!found.length || new Set(found.map(r=>r.status)).size!==1 || !Object.hasOwn(statuses,found[0].status)) return unknown;
        if(attempts.length>1 && receiptIds.length<attempts.length && validBaseline &&
            rows.some(r=>!baseline.ids.includes(r.id) && r.id!==found[0].id && r.type===found[0].type &&
              normalize(r.title)===normalize(content.versions?.[platform]?.title||content.title))) return {result:'ambiguous',accountIdentity};
        return {result:statuses[found[0].status],accountIdentity,externalId:found[0].id};
      }
      const version = content.versions?.[platform] ?? {};
      const title = normalize(version.title || content.title), body = normalize(version.body || content.body);
      const candidates = rows.filter(r=>!baseline.ids.includes(r.id) && normalize(r.title)===title);

      if(rules.detail && candidates.length && candidates.length<=3) {
        const session=await runtime.open(account,false,false);
        const page=pages.get(session.context);
        for(const candidate of candidates) {
          if(!candidate.link || !page || page.isClosed()) return unknown;
          await page.goto(candidate.link,{waitUntil:'domcontentloaded'});
          if(workId(platform,page.url())!==candidate.id) return unknown;
          const heading=page.locator(rules.detail.title),article=page.locator(rules.detail.body);
          if(await heading.count()!==1 || await article.count()!==1 || !await heading.isVisible() || !await article.isVisible())return unknown;
          if(normalize(await heading.innerText())!==title)return unknown;
          candidate.body=await article.innerText();
        }
        if((await runtime.check(account,true)).platformId!==account.platform_id)return unknown;
      }
      if (candidates.length > 1) {
        const matches = candidates.filter(r=>body && normalize(r.body)===body && r.type===rules.types[content.type] &&
          Date.parse(r.time)>=Date.parse(attempts[0].invoked_at));
        return {result:attempts.length>1 && matches.length>1?'duplicate_suspected':'ambiguous',accountIdentity};
      }
      if (!candidates.length && coverage && baseline.complete && title && body) {
        // Unattributed new works of the same type can be edited versions of this submission.
        if (rows.some(r=>!baseline.ids.includes(r.id) && r.type===rules.types[content.type])) return {result:'ambiguous',accountIdentity};
        if (!rules.types[content.type] || rows.some(r=>!Object.values(rules.types).includes(r.type))) return unknown;
        return {result:'absent_valid',accountIdentity,candidates:[],
          coverage:{...coverage,windowStart:Date.parse(attempts[0].invoked_at),windowEnd:Date.now()}};
      }
      const row = candidates[0];
      if (!row?.id || !body || normalize(row.body)!==body || row.type!==rules.types[content.type] ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(row.time) || !(Date.parse(row.time)>=Date.parse(attempts[0].invoked_at)) ||
          Date.parse(row.time)>Date.now()) return unknown;
      return {result:Object.hasOwn(statuses,row.status)?statuses[row.status]:'inconclusive',accountIdentity,externalId:row.id};
    }
  };
}

export function workId(platform,href) {
  let url;
  try {url=new URL(href);} catch{return null;}
  if(url.protocol!=='https:' || url.username || url.password || url.port) return null;
  if(platform==='bilibili'&&url.hostname==='www.bilibili.com'){const article=url.pathname.match(/^\/(?:opus\/(\d+)|read\/(cv\d+))\/?$/);if(article)return article[1]||article[2];}
  const formats={
    zhihu:['zhuanlan.zhihu.com',/^\/p\/(\d+)\/?$/],
    douyin:['www.douyin.com',/^\/video\/(\d+)\/?$/],
    bilibili:['www.bilibili.com',/^\/video\/(BV[A-Za-z0-9]+)\/?$/],
    xhs:['www.xiaohongshu.com',/^\/explore\/([a-fA-F0-9]+)\/?$/]
  };
  const format=formats[platform];
  return format && url.hostname===format[0] ? url.pathname.match(format[1])?.[1]??null : null;
}
