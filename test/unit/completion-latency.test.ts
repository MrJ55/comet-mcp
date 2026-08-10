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

// ---------------------------------------------------------------------------
// ADR 0010 — sentinel completion marker
// ---------------------------------------------------------------------------

function sentinelDriver(answer: string, comply = true) {
  const calls = { asked: [], polls: 0, reminders: 0 };
  // the driver echoes the sentinel from the WRAPPED prompt so the response ends
  // with the SAME sentinel dispatchAsk generated (compliance simulation);
  // comply=false → the model ignores the instruction (no sentinel)
  const echoedAnswer = (prompt: string) => {
    // capture the sentinel: "then the code <X>" in the status-line format
    const m = prompt.match(/then the code (\S+)/) ?? prompt.match(/exact string (\S+)/);
    return comply && m ? answer + '\n\nTurn 1, 08/09/26, 10:53 PM CEST, Test Model, 2%, ' + m[1] : answer;
  };
  return {
    provider: 'gemini',
    open: async () => ({ provider: 'gemini', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      calls.polls++;
      if (calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      const wrapped = calls.asked[0] ?? '';
      return { state: 'completed', steps: [], currentStep: '', response: echoedAnswer(wrapped), markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'gemini', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: calls,
  } as any;
}

test('ADR 0010/0011: withSentinelInstruction wraps the prompt (all-turns status line) + generateSentinel is random', async () => {
  const { withSentinelInstruction, generateSentinel } = await import('../../dist/drivers/index.js');
  const s = generateSentinel();
  assert.equal(s.length, 10);
  const wrapped = withSentinelInstruction('What is X?', s);
  assert.ok(wrapped.includes(s));
  assert.ok(wrapped.includes('end EVERY reply in this session'), 'all-turns convention');
  assert.ok(wrapped.includes('<context%>'), 'context% field specified');
  assert.ok(wrapped.includes('MM/DD/YY'), 'date format enforced');
  assert.notEqual(generateSentinel(), generateSentinel(), 'per-ask random');
});

test('ADR 0011: parseStatusLine — full line parsed, partial line flagged incomplete', async () => {
  const { parseStatusLine } = await import('../../dist/drivers/index.js');
  const full = parseStatusLine('Answer.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(full.found, true);
  assert.equal(full.complete, true);
  assert.equal(full.turn, 'Turn 1');
  assert.equal(full.date, '08/09/26');
  assert.equal(full.model, 'Grok 4.5');
  assert.equal(full.contextPct, '2%');
  // missing fields → found but incomplete
  const partial = parseStatusLine('Answer.\n\nTurn 1, 08/09/26, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(partial.found, true);
  assert.equal(partial.complete, false);
  // no sentinel → not found
  const none = parseStatusLine('Just an answer.', 'Zz9Xq2Gm');
  assert.equal(none.found, false);
});

test('ADR 0011 amendment: stripSentinel removes ONLY the token — status line PRESERVED (2026-08-10)', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const r = stripSentinel('Answer text.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(r.found, true);
  assert.equal(r.text, 'Answer text.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%', 'sentinel + separator removed, status line kept');
  assert.ok(!r.text.includes('Zz9Xq2Gm'), 'sentinel token never leaks');
  assert.ok(r.text.includes('Turn 1'), 'status line preserved as provenance');
  // bare token still handled
  const bare = stripSentinel('Answer.\n\nZz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(bare.found, true);
  assert.equal(bare.text, 'Answer.');
});

test('ADR 0010: stripSentinel removes a terminal sentinel (own line) + trailing ws', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const r = stripSentinel('The answer.\n\nZz9Xq2Gm\n', 'Zz9Xq2Gm');
  assert.equal(r.found, true);
  assert.equal(r.text, 'The answer.');
  // sentinel mid-string (NOT terminal) → untouched
  const n = stripSentinel('Zz9Xq2Gm mid sentence, more text', 'Zz9Xq2Gm');
  assert.equal(n.found, false);
  assert.equal(n.text, 'Zz9Xq2Gm mid sentence, more text');
});

test('ADR 0010: stripSentinel also cleans MARKDOWN content (leak caught live on claude)', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const md = stripSentinel('**Mercury** is smallest.\n\nABC123', 'ABC123');
  assert.equal(md.found, true);
  assert.equal(md.text, '**Mercury** is smallest.');
  assert.ok(!md.text.includes('ABC123'), 'markdown sentinel stripped');
  // markdown without a terminal sentinel is untouched
  const md2 = stripSentinel('**Saturn** is second.', 'ABC123');
  assert.equal(md2.found, false);
});

test('ADR 0010: completionMarker ask — sentinel present → finalizes on FIRST completed poll, sentinel stripped from stored response', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('A complete answer.');  // driver echoes the dispatch-generated sentinel
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // the driver was asked the WRAPPED prompt (with the status-line instruction)
  assert.ok(d._calls.asked[0].includes('end EVERY reply in this session'), 'prompt wrapped with all-turns status line');
  const outcome = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(outcome?.completed, true, 'sentinel ⇒ authoritative ⇒ completes on first completed poll (no 8s window)');
  assert.equal(outcome?.response, 'A complete answer.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Test Model, 2%', 'sentinel stripped, status line preserved');
  // the sentinel (from the wrapped prompt) must not leak into the response
  const wrappedPrompt = d._calls.asked[0] ?? '';
  const sentinelInPrompt = wrappedPrompt.match(/then the code (\S+)/)?.[1] ?? '';
  assert.ok(sentinelInPrompt.length > 0, 'sentinel present in wrapped prompt');
  assert.ok(!outcome?.response.includes(sentinelInPrompt), 'no sentinel leak');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('ADR 0011: non-compliant model (no sentinel) → reminder injected ONCE, ask stays pending', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('Plain answer without the marker', false);
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // completed but NO sentinel ⇒ ADR 0011 injects a bounded reminder, stays pending
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.ok(first && !first.completed, 'not completed yet (reminder path)');
  assert.equal(first?.status, 'reminder_sent', 'reminder injected, awaiting the model reply');
  assert.equal(d._calls.asked.length, 2, 'reminder sent as a follow-up ask in the thread');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending (compliance loop)');
  // a SECOND non-compliant poll does NOT re-inject (bounded — one reminder)
  const second = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(d._calls.asked.length, 2, 'reminder not re-sent (bounded once)');
  assert.ok(second && !second.completed, 'falls to the normal stability path after the reminder');
});

test('ADR 0011: reminder loop — model complies after the reminder → finalizes authoritative with status line stripped', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  // driver ignores the first instruction, complies on the reminder (ask #2)
  const d = {
    provider: 'gemini',
    open: async () => ({ provider: 'gemini', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { (d as any)._calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      const calls = (d as any)._calls;
      calls.polls++;
      if (calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      if (calls.asked.length < 2) {
        // first ask: compliant-looking answer WITHOUT the status line
        return { state: 'completed', steps: [], currentStep: '', response: 'First answer, no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      }
      // after the reminder (ask #2): now WITH the status line + sentinel
      const m = calls.asked[1].match(/then the code (\S+)/) ?? calls.asked[1].match(/exact string (\S+)/);
      const sentinel = m?.[1] ?? 'NOPE';
      return { state: 'completed', steps: [], currentStep: '', response: 'First answer, no status line.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Test, 2%, ' + sentinel, markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'gemini', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(first?.status, 'reminder_sent', 'reminder injected');
  const second = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(second?.completed, true, 'compliance after reminder ⇒ finalizes');
  assert.equal(second?.response, 'First answer, no status line.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Test, 2%', 'sentinel stripped, status line preserved');
  assert.ok(!second?.response.includes('NOPE'), 'no sentinel leak');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized after reminder loop');
});

// ---------------------------------------------------------------------------
// Fast internal advance timer (2026-08-09, user-requested)
// ---------------------------------------------------------------------------

test('advancer: a finished ask finalizes via the timer sweep WITHOUT any client poll', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('Timer-finalized answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  assert.ok(isAskPending(dispatched.idempotencyKey), 'pending after dispatch');
  // sweep with now far enough past startTime to clear the age guard
  const advanced = await advancePendingAsks(Date.now() + 5000);
  assert.ok(advanced >= 1, 'timer advanced the pending ask');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized by the timer — no client poll needed');
  // the response is durable + sentinel-free
  const { eventsForCorrelation } = await import('../../dist/core/event-store.js');
  const resp = [...eventsForCorrelation(dispatched.correlationId)].reverse().find((e) => e.type === 'response.received' || e.type === 'response.amended');
  assert.ok(resp?.response?.poll.response.includes('Timer-finalized answer.'), 'response stored');
  assert.ok(resp?.response?.poll.response.includes('Turn 1'), 'status line preserved in event store (provenance)');
  assert.ok(!resp?.response?.poll.response.includes('exact string') && !/\b[A-Za-z0-9]{10}\b/.test(resp?.response?.poll.response.replace('Timer-finalized answer.', '')), 'no sentinel token in stored response');
});

test('advancer: replayOutcomeIfRecorded recovers the CLEAN outcome after server-side finalize (ADR 0011 live bug)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, replayOutcomeIfRecorded } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('Clean recovered answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  await advancePendingAsks(Date.now() + 5000); // advancer finalizes, entry removed
  const replayed = replayOutcomeIfRecorded(dispatched.idempotencyKey);
  assert.ok(replayed, 'outcome recoverable by idempotencyKey after advancer finalize');
  assert.ok(replayed!.response.includes('Clean recovered answer.'), 'answer present');
  assert.ok(replayed!.response.includes('Turn 1'), 'status line preserved via replay');
  assert.ok(!/\b[A-Za-z0-9]{10}\b/.test(replayed!.response.replace('Clean recovered answer.', '')), 'no sentinel token in replayed outcome');
});

test('advancer: age guard — a JUST-dispatched ask is skipped on the first sweep (dispatch→submit window)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('Fast answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // sweep at NOW (no age added) — the ask is younger than ADVANCE_MIN_AGE_MS
  const advanced = await advancePendingAsks(Date.now());
  assert.equal(advanced, 0, 'too-young ask not advanced (would race driver.ask submission)');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending');
});

test('ADR 0011 amendment: relayed envelope carries the source STATUS LINE as provenance, never the sentinel', async () => {
  const { _resetForTests, recordEnvelopeCreated, recordSendEvent, recordResponseReceived, recordDeliveryReceipt } = await import('../../dist/core/event-store.js');
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  const { prepareRelay } = await import('../../dist/core/relay.js');
  _resetForTests();
  // a completed source whose response ends with a status line (sentinel stripped at
  // finalize, line preserved — this is the stored shape after the ADR 0011 amendment)
  const env = makeEnvelope('grok', 'relay-src');
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.accepted');
  recordResponseReceived(env, 'grok', {
    messageId: 'pm-1', contentHash: 'ch-1', cursor: 'cur', state: 'completed',
    text: 'Source answer.\n\nTurn 2, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%', steps: [],
  }, 'tab-1');
  recordDeliveryReceipt({ receiptId: 'r', envelopeId: env.idempotencyKey, correlationId: env.correlationId, idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString() });
  const result = await prepareRelay({ sourceCorrelationId: env.correlationId, destination: 'claude', attributionHeader: 'grok via relay to claude' });
  assert.ok(result.ok, 'relay prepared');
  const r = result as Extract<typeof result, { ok: true }>;
  // the relayed content carries the source's status line (self-attesting provenance)
  assert.ok(r.envelope.content.includes('Turn 2, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%'), 'source status line relayed — receiver knows the origin');
  assert.ok(!/\b[A-Za-z0-9]{10}\b/.test(r.envelope.content), 'no sentinel token in relayed content');
});

test('advancer: sweep is bounded per tick (thundering-herd guard)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, ADVANCE_MAX_PER_TICK, listPendingAsks } = await import('../../dist/drivers/index.js');
  _resetForTests();
  // dispatch several asks so the cap binds
  const keys: string[] = [];
  for (let i = 0; i < ADVANCE_MAX_PER_TICK + 2; i++) {
    const d = sentinelDriver('Answer ' + i);
    const s = await d.open();
    const disp = await dispatchAsk(d, s, 'Q' + i, { timeoutMs: 60000, completionMarker: true });
    keys.push(disp.idempotencyKey);
  }
  const advanced = await advancePendingAsks(Date.now() + 5000);
  assert.ok(advanced <= ADVANCE_MAX_PER_TICK, `per-tick cap respected (advanced ${advanced}, cap ${ADVANCE_MAX_PER_TICK})`);
  // the rest remain pending for later sweeps
  assert.ok(listPendingAsks().length >= 2, 'leftover asks pending for later sweeps');
});

test('ADR 0011 guard (2026-08-10 grok live bug): UNVERIFIED send must NOT trigger the reminder loop', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  // driver whose ask returns status 'unknown' (submit NOT verified — composer
  // still had text, like grok on a fresh tab). The prompt never rendered.
  const d = {
    provider: 'grok',
    open: async () => ({ provider: 'grok', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => ({ receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'unknown' as const, recordedAt: '', details: 'submit not verified' } }),
    poll: async () => ({ state: 'completed', steps: [], currentStep: '', response: 'A stale reply with no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '' }),
    stop: async () => true, reset: async () => {}, health: async () => ({ provider: 'grok', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // even though the poll looks 'completed' without a sentinel, the send was NOT
  // verified — the reminder must NOT fire (a phantom send has no reply to fix)
  const outcome = await advanceAsk(dispatched.idempotencyKey);
  assert.notEqual(outcome?.status, 'reminder_sent', 'phantom send must NOT enter the compliance loop');
});
