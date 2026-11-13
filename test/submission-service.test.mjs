import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { submissionService } from '../submission-service.mjs';

test('迁移可重复；历史未知、点击超时和事务失败的名额保持一致', t => {
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT,updated TEXT,receipt TEXT);
    CREATE TABLE events(job_id TEXT,state TEXT,created TEXT);
    INSERT INTO jobs(id,state,updated) VALUES('old','unknown','2026-01-01'),('new','uploading','2026-01-01');
    INSERT INTO events VALUES('old','submitting','2026-01-01');`);
  const clock = ()=>'2026-01-02';
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM publication_attempts').get().n;
  const event = (id,state) => db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,id);
  submissionService(db,event,clock);
  const fail = submissionService(db,()=>{throw Error('write failed');},clock);
  assert.throws(()=>fail('new',''),/write failed/);
  assert.equal(count(),1);
  const begin = submissionService(db,event,clock);
  begin('new','');
  assert.throws(()=>begin('new',''),/状态/);
  db.exec("UPDATE jobs SET state='uploading'");
  for (const id of ['old','new']) assert.throws(()=>begin(id,''),/名额/);
  assert.equal(count(),2);
});
