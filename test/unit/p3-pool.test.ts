/**
 * P3 unit tests — circuit breaker + poll backoff + tab cap + last-tab decision.
 * Run: node --test test/unit/p3-pool.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  pollDelayFor, recordPollSuccess, recordPollFailure, isCircuitOpen,
} from '../../dist/drivers/index.js';
import { TabCapExceededError, DEFAULT_TAB_CAP } from '../../dist/cdp-pool.js';

test('P3 backoff: base delay 2s, doubles per failure, caps at 15s', () => {
  assert.equal(pollDelayFor('tab-a'), 2000);
  // simulate failures to grow the backoff via the breaker's failure counter
  for (let i = 0; i < 3; i++) recordPollFailure('tab-b');
  assert.equal(pollDelayFor('tab-b'), 15000); // 2s * 2^3 = 16s, capped at 15s
  assert.ok(pollDelayFor('tab-b') <= 15000, 'never exceeds the 15s cap');
});

test('P3 breaker: 5 consecutive failures opens the circuit; success resets it', () => {
  // fresh tab — failures below threshold keep the circuit closed
  for (let i = 0; i < 4; i++) {
    assert.equal(recordPollFailure('tab-c'), 0, `failure ${i + 1} must not open the circuit`);
    assert.equal(isCircuitOpen('tab-c'), false);
  }
  // 5th failure opens it (cooldown active)
  const cooldown = recordPollFailure('tab-c');
  assert.ok(cooldown > 0, '5th failure opens the circuit');
  assert.equal(isCircuitOpen('tab-c'), true);
  // success closes the breaker (half-open retry path)
  recordPollSuccess('tab-c');
  assert.equal(isCircuitOpen('tab-c'), false);
  assert.equal(pollDelayFor('tab-c'), 2000, 'backoff resets to base after success');
});

test('P3 cap: TabCapExceededError carries the cap and a clear code', () => {
  const err = new TabCapExceededError(DEFAULT_TAB_CAP);
  assert.equal(err.name, 'TabCapExceededError');
  assert.equal(err.cap, DEFAULT_TAB_CAP);
  assert.ok(err.message.includes('tab_cap_exceeded'), 'message carries the machine-readable code');
  assert.ok(err.message.includes(String(DEFAULT_TAB_CAP)), 'message carries the cap value');
});

test('P3 cap default is 5 (P0 measured safe limit)', () => {
  assert.equal(DEFAULT_TAB_CAP, 5);
});
