import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAbsentRetry } from '../workflow/retry-policy.mjs';

test('有效缺席间隔、冷却、最后跨尝试查重与迟到作品', () => {
  const state = { policy:{ retry:{allowAbsentAfterTimeout:true,maxResends:2,cooldownSeconds:[10,20]},
    verification:{enabled:true,checkIntervalSeconds:2,requiredValidChecks:2,absenceWindowSeconds:5,lastCheckFreshnessSeconds:2} },
    invokedAt:0,deadlineAt:60000,now:15000,ordinal:1,observations:[] };
  const add = (checkedAt, extra={}) => state.observations.push({checkedAt,ordinal:1,result:'absent_valid',
    coverage:{complete:true},accountIdentity:{expected:'a',observed:'a',verified:true},...extra});
  const reason = () => evaluateAbsentRetry(state).reasonCode;
  add(1000); add(1100); add(3000,{coverage:{complete:false}});
  assert.equal(reason(),'insufficient_checks');
  add(4000);
  state.now=6000;
  assert.equal(reason(),'cooldown');
  state.now=15000;
  assert.equal(reason(),'final_check_required');
  add(15000,{allAttemptsCovered:true});
  assert.equal(reason(),'eligible');
  add(15000,{result:'found_reviewing'});
  assert.equal(reason(),'candidate_found');
  state.ordinal=3;
  assert.equal(reason(),'limit_exhausted');
  state.stopped=true;
  assert.equal(reason(),'stopped');
});
