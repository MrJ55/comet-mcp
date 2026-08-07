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

/** Poll once and render the human/progress view (shared by poll tools). */
export function renderPoll(poll: PollResult): string {
  if (poll.state === 'completed' && poll.response) {
    return poll.response + (poll.markdown ? `\n\n---\n\n${poll.markdown}` : '');
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
  await driver.ask(session, prompt);

  const startTime = Date.now();
  const stepsCollected: string[] = [];
  let sawNewResponse = false;
  let last: PollResult | null = null;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    last = await driver.poll(session);
    for (const step of last.steps) {
      if (!stepsCollected.includes(step)) stepsCollected.push(step);
    }
    if (last.response.length > 0) sawNewResponse = true;
    if ((last.state === 'completed') && sawNewResponse) {
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
