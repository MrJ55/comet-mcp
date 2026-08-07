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
import { writeFileSync, mkdirSync } from 'fs';
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

/**
 * Persist a full provider response (text + markdown) to the outputs dir and return
 * a compact result that fits small MCP-gateway result budgets (~500 bytes). The full
 * content is always available at the returned path — the gateway cap does not limit
 * what the client can retrieve (2026-08-07 finding: pi's gateway truncates tool
 * results at a few hundred bytes, so long responses must be file-backed, not inline).
 */
export function persistResponse(provider: string, poll: PollResult): { text: string; path: string; bytes: number } {
  const dir = join(packageRoot(), 'responses');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${provider}-${stamp}.md`);
  const body = `# ${provider} response (${stamp})\n\n${poll.response}\n\n---\n\n## Markdown\n\n${poll.markdown ?? '(none)'}\n`;
  writeFileSync(path, body);
  return { text: body, path, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Compact inline preview (fits the gateway budget) + path for the full content. */
export function compactResult(poll: PollResult, path: string): string {
  const preview = poll.response.slice(0, 200);
  return `Status: ${poll.state}\nPreview: ${preview}${poll.response.length > 200 ? '…' : ''}\nFull (${poll.response.length} chars + markdown): ${path}`;
}

/** Persist a completed AskOutcome and return the compact tool-result string. */
export function compactAskResult(provider: string, outcome: AskOutcome): string {
  const dir = join(packageRoot(), 'responses');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${provider}-ask-${stamp}.md`);
  const body = `# ${provider} response (${stamp})\n\n${outcome.response}\n\n---\n\n## Markdown\n\n${outcome.markdown ?? '(none)'}\n`;
  writeFileSync(path, body);
  const preview = outcome.response.slice(0, 200);
  return `Completed (${outcome.response.length} chars).\nPreview: ${preview}${outcome.response.length > 200 ? '…' : ''}\nFull response: ${path}`;
}

/** Poll once and render the human/progress view (shared by poll tools). */
export function renderPoll(poll: PollResult, provider = 'provider'): string {
  if (poll.state === 'completed' && poll.response) {
    // Full content goes to a file; the tool result stays compact (gateway cap).
    const { path, bytes } = persistResponse(provider, poll);
    return compactResult(poll, path) + ` (${bytes} bytes written)`;
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

/** FNV-1a content hash — same as the drivers use for PollResult.contentHash. */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
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
