import { publicationPolicy } from './workflow/publication-policy.mjs';
import { isDeepStrictEqual } from 'node:util';
import { publicationOf } from './publication.mjs';

export function createDispatchService({ db, validate, event, fail, id, now }) {
  return function dispatch(body) {
    if (typeof body.requestKey !== 'string' || body.requestKey.length > 100) throw fail('缺少分发意图标识');
    const policy = publicationPolicy(body.publicationPolicy);
    const nested=db.isTransaction;
    const rollback=()=>db.exec(nested?'ROLLBACK TO dispatch_intent; RELEASE dispatch_intent':'ROLLBACK');
    const commit=()=>db.exec(nested?'RELEASE dispatch_intent':'COMMIT');
    db.exec(nested?'SAVEPOINT dispatch_intent':'BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM dispatches WHERE request_key=?').get(body.requestKey);
      if (prior) {
        const targets = db.prepare('SELECT j.account_id,i.policy_snapshot FROM jobs j JOIN publication_intents i ON i.job_id=j.id WHERE j.dispatch_id=?').all(prior.id);
        if (targets.some(row => !isDeepStrictEqual(policy, publicationPolicy(JSON.parse(row.policy_snapshot)))) || !Array.isArray(body.accountIds) || !isDeepStrictEqual(new Set(body.accountIds), new Set(targets.map(row => row.account_id))) ||
            !isDeepStrictEqual(body.content, JSON.parse(prior.snapshot))) {
          rollback();
          return { status: 409, body: { error: '该分发标识已用于不同稿件或账号', reasonCode: 'request_key_conflict' } };
        }
        commit();
        return { status: 200, body: { id: prior.id, reused: true } };
      }
      // Persist the intent immediately. Browser and identity work belongs to the worker,
      // so another upload or QR scan never rejects a new dispatch or changes its page.
      const issues = validate(body.content, body.accountIds,{deferIdentity:true}); if (issues.length) {
        rollback();
        return { status: 422, body: { error: '校验未通过', issues } };
      }
      const dispatchId = id();
      db.prepare('INSERT INTO dispatches VALUES(?,?,?,?)').run(dispatchId, body.requestKey, JSON.stringify(body.content), now());
      for (const accountId of new Set(body.accountIds)) {
        const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId); const jobId = id();
        db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(jobId, dispatchId, a.id, a.platform, a.name, a.mode, 'queued', ['normal', 'login', 'unknown'].includes(body.scenario) ? body.scenario : 'normal', now(), null);
        db.prepare('INSERT INTO publication_intents(job_id,policy_snapshot) VALUES(?,?)').run(jobId,JSON.stringify(policy));
        const p=publicationOf(body.content);
        event(jobId, 'queued', `${a.mode==='demo'?'演示任务':'真实任务'}：${p.mode==='auto'?'工具直接发布':'发布前人工处理'}；AI辅助创作：${p.aiAssisted===null?'旧任务未指定':p.aiAssisted?'勾选':'不勾选'}。已保存内容和选项快照，执行器繁忙时自动排队，执行时核验账号。`);
      }
      commit();

      return { status: 201, body: { id: dispatchId } };
    } catch (e) { rollback(); throw e; }
  };
}
