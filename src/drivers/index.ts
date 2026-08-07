/**
 * Driver registry + provider-neutral ask/poll helpers (P2 wiring).
 *
 * The cleanest path to making Grok usable from MCP tools: a registry maps provider
 * names to ChatDriver instances, and generic helpers implement the ask→wait→respond
 * loop ONCE over the ChatDriver contract. The `provider_*` MCP tools dispatch via the
 * registry; `comet_*` tools become thin Perplexity aliases over the same helpers
 * (identical external behavior — the P1 migration path).
 */

import type { ChatDriver, PollResult, TabSession } from '../types/provider.js';
import type { ProviderId } from '../types/conversation.js';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { packageRoot } from '../core/registry.js';
import { perplexityDriver } from './perplexity.js';
import { grokDriver } from './grok.js';

const DRIVERS: Record<string, ChatDriver> = {
  perplexity: perplexityDriver,
  grok: grokDriver,
};

/** Resolve a driver by provider name, or null for unknown. */
export function getDriver(provider: string): ChatDriver | null {
  return DRIVERS[provider] ?? null;
}

/** List registered provider names. */
export function listDrivers(): string[] {
  return Object.keys(DRIVERS);
}

/** A normalized ask outcome — the shared response shape for provider_ask/comet_ask. */
export interface AskOutcome {
  completed: boolean;
  response: string;
  markdown: string | null;
  steps: string[];
  currentStep: string;
  status: string;
  agentBrowsingUrl: string;
  timedOut: boolean;
}

/** Normalize prompt — convert markdown/bullets to natural text (preserves comet_ask behavior). */
export function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/^[-*•]\s*/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Response store (ADR: file-backed, ID-based, retention-aware)
// ---------------------------------------------------------------------------
// 2026-08-07 critique integration (Perplexity + Grok): the compact result must be
// STRUCTURED (not a formatted string), retrieval should be ID-based chunked access
// (not filesystem paths), and the store needs retention. This module writes the full
// response (text + markdown) to responses/<id>.md, keeps an in-memory registry of
// {id, provider, path, hash, fullChars, markdownChars, createdAt, expiresAt}, and
// enforces a TTL + max-count retention.

const RESPONSES_DIR = () => join(packageRoot(), 'responses');
export const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_RESPONSES = 100;

export interface ResponseRecord {
  id: string;
  provider: string;
  path: string;
  contentHash: string;
  fullChars: number;
  markdownChars: number;
  createdAt: string;
  expiresAt: string;
}

const registry = new Map<string, ResponseRecord>();

/** FNV-1a content hash — same as the drivers use for PollResult.contentHash. */
export function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Clean up expired + over-count responses on startup and after each write. */
export function enforceRetention(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, rec] of registry) {
    if (new Date(rec.expiresAt).getTime() < now) {
      try { unlinkSync(rec.path); } catch { /* already gone */ }
      registry.delete(id);
      removed++;
    }
  }
  // max-count: drop oldest
  const sorted = [...registry.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  while (sorted.length > MAX_RESPONSES) {
    const [id, rec] = sorted.shift()!;
    try { unlinkSync(rec.path); } catch { /* already gone */ }
    registry.delete(id);
    removed++;
  }
  return removed;
}

/** Persist a full response, return its ID + structured record. */
export function storeResponse(provider: string, text: string, markdown: string | null): { id: string; rec: ResponseRecord } {
  const dir = RESPONSES_DIR();
  mkdirSync(dir, { recursive: true });
  enforceRetention();
  const id = `${provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const path = join(dir, `${id}.md`);
  const body = `# ${provider} response (${id})\n\n${text}\n\n---\n\n## Markdown\n\n${markdown ?? '(none)'}\n`;
  const now = Date.now();
  const rec: ResponseRecord = {
    id, provider, path, contentHash: simpleHash(text),
    fullChars: text.length, markdownChars: markdown?.length ?? 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RESPONSE_TTL_MS).toISOString(),
  };
  // atomic-ish write: write then register
  writeFileSync(path, body);
  registry.set(id, rec);
  return { id, rec };
}

/** Structured compact result (fits gateway budget). */
export function structuredCompact(rec: ResponseRecord, preview: string, status: string): string {
  return JSON.stringify({
    status,
    responseId: rec.id,
    preview: preview.length > 200 ? preview.slice(0, 200) + '…' : preview,
    previewChars: preview.length,
    fullChars: rec.fullChars,
    markdownChars: rec.markdownChars,
    contentHash: rec.contentHash,
    expiresAt: rec.expiresAt,
  });
}

/** Persist a completed AskOutcome and return the structured compact tool-result string. */
export function compactAskResult(provider: string, outcome: AskOutcome): string {
  const { rec } = storeResponse(provider, outcome.response, outcome.markdown ?? null);
  return structuredCompact(rec, outcome.response, outcome.completed ? 'completed' : outcome.status);
}

/** Chunked retrieval by response ID (Perplexity+Grok critique: ID-based, not path-based). */
export function readResponseChunk(id: string, offset = 0, limit = 4000): { ok: boolean; rec?: ResponseRecord; chunk?: string; error?: string } {
  // registry may be empty after a restart — lazily scan the responses dir by id
  if (!registry.has(id) && existsSync(join(RESPONSES_DIR(), `${id}.md`))) {
    const path = join(RESPONSES_DIR(), `${id}.md`);
    try {
      const body = readFileSync(path, 'utf8');
      const m = body.match(/^# (\S+) response \(([^)]+)\)/m);
      const now = Date.now();
      registry.set(id, {
        id, provider: m?.[1] ?? 'unknown', path,
        contentHash: simpleHash(body), fullChars: body.length, markdownChars: 0,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RESPONSE_TTL_MS).toISOString(),
      });
    } catch { /* fall through to not-found */ }
  }
  const rec = registry.get(id);
  if (!rec) return { ok: false, error: `unknown responseId: ${id}` };
  try {
    const body = readFileSync(rec.path, 'utf8');
    const chunk = body.slice(offset, offset + limit);
    return { ok: true, rec, chunk, error: body.length > offset + limit ? `truncated (more at offset ${offset + limit})` : undefined };
  } catch (e) {
    return { ok: false, error: `read failed: ${e instanceof Error ? e.message : e}` };
  }
}

/** Poll once and render the human/progress view (shared by poll tools). */
export function renderPoll(poll: PollResult, provider = 'provider'): string {
  if (poll.state === 'completed' && poll.response) {
    const { rec } = storeResponse(provider, poll.response, poll.markdown ?? null);
    return structuredCompact(rec, poll.response, 'completed');
  }
  let out = `Status: ${poll.state.toUpperCase()}\n`;
  if (poll.agentBrowsingUrl) out += `Browsing: ${poll.agentBrowsingUrl}\n`;
  if (poll.currentStep) out += `Current: ${poll.currentStep}\n`;
  if (poll.steps.length > 0) out += `\nSteps:\n${poll.steps.map((s) => `  • ${s}`).join('\n')}\n`;
  if (poll.state === 'working' || poll.state === 'streaming') {
    out += `\n[Use provider_stop to interrupt, or comet_screenshot to see current page]`;
  }
  return out;
}

/**
 * Generic ask-and-wait: send the prompt, poll until completed (or timeout), return the
 * outcome. Provider-neutral — the driver's open() handles tab targeting/navigation.
 */
export async function askAndWait(driver: ChatDriver, prompt: string, timeoutMs: number): Promise<AskOutcome> {
  const session: TabSession = await driver.open();

  // Snapshot the conversation state BEFORE sending so we can detect the NEW
  // response reliably (a follow-up in an existing thread already has prior text
  // in the DOM — "any text exists" is not "this turn completed").
  const before = await driver.poll(session);
  const beforeHash = before.contentHash ?? simpleHash(before.response);
  const beforeLen = before.response.length;

  await driver.ask(session, prompt);

  const startTime = Date.now();
  const stepsCollected: string[] = [];
  let sawNewResponse = false;
  let last: PollResult | null = null;
  let prevHash: string | null = null; // for stability check: two identical readings = done

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    last = await driver.poll(session);
    for (const step of last.steps) {
      if (!stepsCollected.includes(step)) stepsCollected.push(step);
    }
    // NEW response = content hash changed OR text grew past the pre-send snapshot.
    // Do NOT latch on mere presence of text (prior turns already have text).
    const hash = last.contentHash ?? simpleHash(last.response);
    if (last.response.length > 0 && (hash !== beforeHash || last.response.length > beforeLen)) {
      sawNewResponse = true;
    }
    // COMPLETED requires stability: the response hash must be unchanged from the
    // PREVIOUS poll. A single 'completed' reading can catch the DOM mid-render
    // (the "Worked for Xs" marker appears while the list is still appending), so
    // returning on first completed can truncate. Require two identical readings.
    if (last.state === 'completed' && sawNewResponse && hash === prevHash && prevHash !== null) {
      return {
        completed: true,
        response: last.response || 'Task completed (no response text extracted)',
        markdown: last.markdown ?? null,
        steps: stepsCollected,
        currentStep: last.currentStep,
        status: last.state,
        agentBrowsingUrl: last.agentBrowsingUrl,
        timedOut: false,
      };
    }
    prevHash = hash;
  }

  const final = last ?? await driver.poll(session);
  return {
    completed: false,
    response: '',
    markdown: null,
    steps: stepsCollected,
    currentStep: final.currentStep,
    status: final.state,
    agentBrowsingUrl: final.agentBrowsingUrl,
    timedOut: true,
  };
}

/** Render the "still in progress" view (preserves comet_ask's message shape). */
export function renderInProgress(outcome: AskOutcome, useCometNames = false): string {
  const stop = useCometNames ? 'comet_stop' : 'provider_stop';
  const poll = useCometNames ? 'comet_poll' : 'provider_poll';
  let msg = `Task in progress (${outcome.steps.length} steps so far).\n`;
  msg += `Status: ${outcome.status.toUpperCase()}\n`;
  if (outcome.currentStep) msg += `Current: ${outcome.currentStep}\n`;
  if (outcome.agentBrowsingUrl) msg += `Browsing: ${outcome.agentBrowsingUrl}\n`;
  if (outcome.steps.length > 0) msg += `\nSteps:\n${outcome.steps.map((s) => `  • ${s}`).join('\n')}\n`;
  msg += `\nUse ${poll} to check progress or ${stop} to cancel.`;
  return msg;
}
