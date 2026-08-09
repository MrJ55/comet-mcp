/**
 * P4 R4 — relay orchestration (provider-neutral; grows across R4→R7).
 *
 * R4 scope (design 05 §3.4): relay_prepare — select a terminal-success source
 * event (completed / completed_late — §1.5: never watching/abandoned), build +
 * canonicalize + hash the relay envelope (R1), run eager policy checks (R3),
 * return envelope + policy evaluation + approvalRequired + approvalHash. NO
 * contact with the destination.
 *
 * The relay chain is ONE correlation, many envelopes (types/conversation.ts
 * ConversationEnvelope.correlationId doc). The prepared envelope's
 * idempotencyKey is fresh per logical send; the envelopeHash is stable across
 * re-prepares because R1 deliberately excludes idempotencyKey/correlationId/
 * createdAt from canonicalization — the same source+destination+policy always
 * yields the same approval hash.
 */

import type { ContentPersistenceMode, ConversationEnvelope, ProviderId, RelayControls } from '../types/conversation.js';
import { computeEnvelopeHash, canonicalizeEnvelope } from './envelope.js';
import { evaluateRelayPolicy, type RelayPolicyEvaluation } from './relay-policy.js';
import { eventsForCorrelation, receiptsForCorrelation, recordEnvelopeCreated } from './event-store.js';

/** A relay source: the terminal-success provider response being relayed. */
export interface RelaySource {
  correlationId: string;
  sourceProvider: ProviderId;
  sourceMessageId?: string;
  sourceContentHash: string;
  /** Full response text — only available when the source event persisted it. */
  content: string;
  /** 'completed' (poll state) — terminal-success per §1.5. */
  state: string;
  cursor?: string;
}

/**
 * Find the terminal-success source for a correlation. §1.5: relay consumes only
 * completed / completed_late — never watching/abandoned. Returns null when no
 * terminal-success response exists (client must finish/verify the ask first).
 */
export function findRelaySource(correlationId: string): RelaySource | null {
  const evs = eventsForCorrelation(correlationId);
  // newest response event (received or deduplicated — same content, no new send)
  const resp = [...evs].reverse().find(
    (e) => e.type === 'response.received' || e.type === 'response.deduplicated',
  );
  if (!resp?.response) return null;
  const receipts = receiptsForCorrelation(correlationId);
  const latest = [...receipts].reverse().find((r) => r.receiptStatus !== undefined);
  const terminal =
    resp.response.poll.state === 'completed' ||
    latest?.receiptStatus === 'completed' ||
    latest?.receiptStatus === 'completed_late';
  if (!terminal) return null; // watching / abandoned / timed_out — not relayable
  return {
    correlationId,
    sourceProvider: resp.response.provider,
    sourceMessageId: resp.response.messageId,
    sourceContentHash: resp.response.contentHash,
    content: resp.response.poll.response,
    state: resp.response.poll.state,
    cursor: resp.response.cursor,
  };
}

/** Inputs to relay_prepare (R4). destination + attribution are the hard ones. */
export interface RelayPrepareInput {
  /** Correlation of the terminal-success source response (the ask to relay). */
  sourceCorrelationId: string;
  destination: ProviderId;
  /** Mandatory in approval-required mode — fail closed if unset (§3.3). */
  attributionHeader?: string;
  contentSizeLimitBytes?: number;
  /** Approval/relay deadline (epoch ms). */
  deadlineMs?: number;
  maxRelaysPerCorrelation?: number;
  /** Opt-in raw markdown pass-through (default false = neutralize structure). */
  rawMarkdown?: boolean;
  contentPersistenceMode?: ContentPersistenceMode;
}

/** Successful prepare result (R4). */
export interface RelayPrepareResult {
  ok: true;
  /** The relay chain's correlation (== source correlation per §correlation doc). */
  correlationId: string;
  idempotencyKey: string;
  envelope: ConversationEnvelope;
  canonical: string;
  envelopeHash: string;
  approvalRequired: boolean;
  evaluation: RelayPolicyEvaluation;
}

export interface RelayPrepareError {
  ok: false;
  error: string;
  /** Set when policy evaluation failed — the reason is machine-checkable. */
  policyReason?: RelayPolicyEvaluation['reason'];
  evaluation?: RelayPolicyEvaluation;
}

/** Relay policy defaults for a prepared envelope (R3 defaults + mandatory enablement). */
function buildRelayControls(input: RelayPrepareInput): RelayControls {
  return {
    mode: 'approval-required',
    approved: false, // approval comes from relay_approve (R5)
    destinationEnabled: true, // the client explicitly named this destination
    attributionHeader: input.attributionHeader,
    contentSizeLimitBytes: input.contentSizeLimitBytes,
    deadlineMs: input.deadlineMs,
    maxRelaysPerCorrelation: input.maxRelaysPerCorrelation,
    rawMarkdown: input.rawMarkdown,
    contentPersistenceMode: input.contentPersistenceMode,
  };
}

/**
 * R4: prepare a relay. Selects the terminal-success source, builds + canonicalizes
 * + hashes the envelope, runs eager policy checks. NEVER contacts the destination.
 */
export function prepareRelay(input: RelayPrepareInput): RelayPrepareResult | RelayPrepareError {
  const source = findRelaySource(input.sourceCorrelationId);
  if (!source) {
    return {
      ok: false,
      error: `no terminal-success source for correlation '${input.sourceCorrelationId}' — only completed/completed_late responses are relayable (design 05 §1.5)`,
    };
  }
  if (source.content.length === 0) {
    return {
      ok: false,
      error: 'source event has no persisted content (redacted/none mode) — cannot prepare a relay from it',
    };
  }

  const now = new Date().toISOString();
  const envelope: ConversationEnvelope = {
    idempotencyKey: `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    correlationId: source.correlationId, // relay chain = one correlation
    source: source.sourceProvider,
    destination: input.destination,
    content: source.content,
    provenance: {
      sourceProvider: source.sourceProvider,
      sourceMessageId: source.sourceMessageId,
      sourceContentHash: source.sourceContentHash,
      attributedTo: `${source.sourceProvider} via relay to ${input.destination}`,
      relayedAt: now,
      safetyClaimed: false, // ADR 0001 §Relay policy 4 — untrusted, literal false
    },
    relay: buildRelayControls(input),
    budget: {
      maxTurns: 1,
      wallClockDeadlineMs: input.deadlineMs ?? Date.now() + 5 * 60 * 1000,
    },
    createdAt: now,
  };

  // Eager policy checks (R3) — fail closed before any approval is minted.
  // deferApproval: prepare builds approved:false by design; approval_required
  // is the NEXT step (relay_approve), not a prepare-time failure (§3.4).
  const evaluation = evaluateRelayPolicy(envelope, { deferApproval: true });
  if (!evaluation.ok) {
    return {
      ok: false,
      error: `relay policy blocked: ${evaluation.reason} — ${evaluation.details}`,
      policyReason: evaluation.reason,
      evaluation,
    };
  }

  // Durable trail anchor: envelope.created with the relay's persistence mode.
  // (R2 wired the mode into the write path — relay content defaults to redacted.)
  recordEnvelopeCreated(envelope);

  return {
    ok: true,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    canonical: canonicalizeEnvelope(envelope),
    envelopeHash: computeEnvelopeHash(envelope),
    approvalRequired: envelope.relay.mode === 'approval-required',
    evaluation,
  };
}
