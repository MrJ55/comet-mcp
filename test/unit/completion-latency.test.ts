/**
 * P4 latency fix tests (2026-08-09, consult-validated design).
 *
 * completionStability(windowMs), CONFIDENCE_WINDOWS, windowForPoll, and the
 * confidence-aware completion gate: authoritative ⇒ hash-confirmed timer-free;
 * heuristic ⇒ short window; weak ⇒ full 8s; missing confidence ⇒ weak;
 * sawNewResponse is never bypassed.
 *
 * Run: node --test test/unit/completion-latency.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  completionStability,
  MIN_COMPLETION_STABILITY_MS,
  CONFIDENCE_WINDOWS,
  windowForPoll,
} from '../../dist/drivers/index.js';

test('latency: completionStability default window is 8s (unchanged behavior)', () => {
  const now = 1_000_000;
  // first reading starts the clock
  assert.deepEqual(completionStability('h1', null, null, now), { complete: false, stableSince: now });
  // held for 8s → complete
  const held = completionStability('h1', 'h1', now, now + MIN_COMPLETION_STABILITY_MS);
  assert.equal(held.complete, true);
  assert.equal(held.stableSince, now);
  // content change restarts the clock
  const changed = completionStability('h2', 'h1', now, now + 9000);
  assert.deepEqual(changed, { complete: false, stableSince: null });
});

test('latency: completionStability honors a custom windowMs', () => {
  const now = 1_000_000;
  // 3s window: not complete at 2s, complete at 3s
  assert.equal(completionStability('h', null, null, now, 3000).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 3000, 3000).complete, true);
  // 0 window: first reading completes immediately
  assert.equal(completionStability('h', null, null, now, 0).complete, true);
});

test('latency: CONFIDENCE_WINDOWS — authoritative 0, heuristic 3000, weak 8000', () => {
  assert.equal(CONFIDENCE_WINDOWS.authoritative, 0);
  assert.equal(CONFIDENCE_WINDOWS.heuristic, 3000);
  assert.equal(CONFIDENCE_WINDOWS.weak, MIN_COMPLETION_STABILITY_MS);
});

test('latency: windowForPoll — absent confidence ⇒ weak (fail-closed)', () => {
  assert.equal(windowForPoll({} as any), MIN_COMPLETION_STABILITY_MS);
  assert.equal(windowForPoll({ completionConfidence: 'authoritative' } as any), 0);
  assert.equal(windowForPoll({ completionConfidence: 'heuristic' } as any), 3000);
  assert.equal(windowForPoll({ completionConfidence: 'weak' } as any), MIN_COMPLETION_STABILITY_MS);
});

test('latency: windowForPoll — entry override wins over confidence map', () => {
  assert.equal(windowForPoll({ completionConfidence: 'heuristic' } as any, 5000), 5000);
  assert.equal(windowForPoll({ completionConfidence: 'authoritative' } as any, 1000), 1000);
});

// ---------------------------------------------------------------------------
// Gate behavior — authoritative (hash-confirmed, timer-free)
// ---------------------------------------------------------------------------

test('latency GATE: authoritative + same hash as prev → complete on first poll (no window)', () => {
  // hash-confirmed: prevHash === hash ⇒ complete immediately, even though the
  // stability window (8s) has not elapsed
  const now = 1_000_000;
  const stableSince = now; // clock started, not yet 8s
  const { complete } = completionStability('h', 'h', stableSince, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, true, 'authoritative window 0 ⇒ immediate');
});

test('latency GATE: authoritative + cold start (prevHash null) → complete', () => {
  const now = 1_000_000;
  const { complete } = completionStability('h', null, null, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, true, 'cold-start first content + marker ⇒ done');
});

test('latency GATE: authoritative + changed hash → NOT complete (hash-confirmed fails)', () => {
  const now = 1_000_000;
  const { complete, stableSince } = completionStability('h2', 'h1', null, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, false, 'content still moving ⇒ wait, never latch partial');
  assert.equal(stableSince, null, 'clock restarted on content change');
});

// ---------------------------------------------------------------------------
// Gate behavior — heuristic / weak keep the window
// ---------------------------------------------------------------------------

test('latency GATE: heuristic requires ~3s of stability', () => {
  const now = 1_000_000;
  assert.equal(completionStability('h', null, null, now, CONFIDENCE_WINDOWS.heuristic).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 2900, CONFIDENCE_WINDOWS.heuristic).complete, false, '2.9s not enough');
  assert.equal(completionStability('h', 'h', now, now + 3000, CONFIDENCE_WINDOWS.heuristic).complete, true, '3s enough');
});

test('latency GATE: weak requires the full 8s window (anti-truncation preserved)', () => {
  const now = 1_000_000;
  assert.equal(completionStability('h', 'h', now, now + 7999, CONFIDENCE_WINDOWS.weak).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 8000, CONFIDENCE_WINDOWS.weak).complete, true);
});

// ---------------------------------------------------------------------------
// Grok message-scoped authoritative (Ship 2)
// ---------------------------------------------------------------------------

test('latency: grok determineGrokStatus returns authoritative only when LAST message has "Worked for Xs"', async () => {
  const { determineGrokStatus } = await import('../../dist/providers/extraction.js');
  assert.equal(determineGrokStatus({ lastMessageText: 'Worked for 3s\nAnswer' }).completionConfidence, 'authoritative');
  assert.equal(determineGrokStatus({ lastMessageText: 'plain answer' }).completionConfidence, 'weak');
  assert.equal(determineGrokStatus({ lastMessageText: 'Working for 3s' }).state, 'streaming');
});

// ---------------------------------------------------------------------------
// Perplexity per-branch confidence (Ship 3)
// ---------------------------------------------------------------------------

test('latency: perplexity determineStatus — follow-up authoritative, steps-only heuristic', async () => {
  const { determineStatus } = await import('../../dist/providers/extraction.js');
  const followUp = determineStatus({ hasActiveStopButton: false, hasLoadingSpinner: false, bodyText: 'Answer. Ask a follow-up' });
  assert.equal(followUp.completionConfidence, 'authoritative');
  const steps = determineStatus({ hasActiveStopButton: false, hasLoadingSpinner: false, bodyText: '4 steps completed' });
  assert.equal(steps.completionConfidence, 'heuristic');
  const working = determineStatus({ hasActiveStopButton: true, hasLoadingSpinner: false, bodyText: 'Working' });
  assert.equal(working.state, 'working');
});

// ---------------------------------------------------------------------------
// Follow-up A: response.amended (ADR 0009) — growth after early finalize
// ---------------------------------------------------------------------------

test('amended: same-prefix GROWTH after a recorded response → response.amended, not a second response.received', async () => {
  const es = await import('../../dist/core/event-store.js');
  const { _resetForTests, eventsForCorrelation, recordEnvelopeCreated, recordResponseReceived, recordResponseAmended } = es;
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const env = makeEnvelope('grok', 'amend-key');
  recordEnvelopeCreated(env);
  // first terminal response (early authoritative finalize)
  recordResponseReceived(env, 'grok', {
    messageId: 'm1', contentHash: 'h1', cursor: 'c', state: 'completed',
    text: 'The answer starts here', steps: [],
  }, 'tab-1');
  // later poll sees the same content GROWN (same prefix, longer)
  const amended = recordResponseAmended(env, 'grok', {
    messageId: 'm2', contentHash: 'h2', cursor: 'c', state: 'completed',
    text: 'The answer starts here and continues with more detail', steps: [],
  });
  assert.ok(amended, 'growth recorded as amendment');
  assert.equal(amended!.type, 'response.amended');
  const types = eventsForCorrelation(env.correlationId).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'response.received').length, 1, 'exactly ONE response.received');
  assert.equal(types.filter((t) => t === 'response.amended').length, 1, 'one amendment');
});

test('amended: NOT a same-prefix superset → returns null (genuinely new turn, record fresh received)', async () => {
  const es = await import('../../dist/core/event-store.js');
  const { _resetForTests, recordEnvelopeCreated, recordResponseReceived, recordResponseAmended } = es;
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const env = makeEnvelope('grok', 'amend-key2');
  recordEnvelopeCreated(env);
  recordResponseReceived(env, 'grok', {
    messageId: 'm1', contentHash: 'h1', cursor: 'c', state: 'completed',
    text: 'First turn answer', steps: [],
  }, 'tab-1');
  // different content (not a prefix superset)
  const notAmended = recordResponseAmended(env, 'grok', {
    messageId: 'm2', contentHash: 'h2', cursor: 'c', state: 'completed',
    text: 'Unrelated new content', steps: [],
  });
  assert.equal(notAmended, null, 'non-superset is NOT an amendment');
});
