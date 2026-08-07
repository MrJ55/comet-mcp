/**
 * Perplexity ChatDriver (P1) — refactors CometAI behavior into the provider contract
 * without changing user-visible behavior (P1 task list item: "Refactor Perplexity
 * behavior into the provider contract without changing user-visible behavior").
 *
 * Controls resolve through the provider registry (src/providers/entries/perplexity.json)
 * with ADR 0003 fingerprint rebind, instead of the hardcoded INPUT_SELECTORS list in
 * the old CometAI. Response extraction lives in src/providers/extraction.ts (pure,
 * testable) — the in-page script only COLLECTS raw prose + signals.
 *
 * The comet_* MCP tools keep their exact external behavior; they now call this driver
 * (migration path from comet_* to provider_*, P1 item).
 */

import { cometClient } from '../cdp-client.js';
import type { EvaluateResult } from '../types.js';
import type {
  ChatDriver, PollResult, TabSession, HealthReport, ProviderState,
} from '../types/provider.js';
import type { DeliveryReceipt } from '../types/conversation.js';
import { loadEntry, resolveWithConfidence, recordSuccess, recordFailure, writeEntry } from '../core/registry.js';
import { resolveWithRebind } from '../core/fingerprint.js';
import {
  extractResponse, extractSteps, determineStatus, filterProseTexts,
} from '../providers/extraction.js';
import { htmlToMarkdown } from '../providers/markdown.js';

/** Composer selectors used by the old CometAI, kept as the heuristic fallback chain. */
const COMPOSER_FALLBACKS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

const entry = () => loadEntry('perplexity');

/** Wrap cometClient.evaluate's EvaluateResult into a bare value (or null). */
async function evalValue(expression: string): Promise<any> {
  try {
    const r: EvaluateResult = await cometClient.evaluate(expression);
    return r?.result?.value ?? null;
  } catch {
    return null;
  }
}

/** Resolve a control selector via registry confidence + fingerprint rebind. */
async function resolveControl(name: 'composer' | 'sendButton' | 'modelPicker' | 'responseContainer', conditional = false): Promise<string | null> {
  const e = entry();
  if (!e) return null;
  const { selector, control } = resolveWithConfidence(e, name);
  if (!selector) return null;

  // fingerprint rebind on miss (ADR 0003)
  const resolved = await resolveWithRebind(
    (expr) => evalValue(expr),
    selector,
    control?.fingerprint,
  );

  if (resolved) {
    if (resolved.rebound) {
      const updated = recordSuccess(control!);
      updated.last_sig = resolved.selector;
      (e.controls as any)[name] = updated;
      writeEntry(e);
    }
    return resolved.selector;
  }

  // genuine miss — record failure (conditional controls skipped: they may be
  // legitimately absent until their precondition is met)
  if (!conditional && control) {
    const { control: updated } = recordFailure(control);
    (e.controls as any)[name] = updated;
    writeEntry(e);
  }
  return null;
}

/** Find a usable composer: entry selector first (with rebind), then fallback chain. */
async function findComposer(): Promise<string | null> {
  const entrySel = await resolveControl('composer');
  if (entrySel) return entrySel;
  for (const sel of COMPOSER_FALLBACKS) {
    const hit = await evalValue(`document.querySelector(${JSON.stringify(sel)}) !== null`);
    if (hit === true) return sel;
  }
  return null;
}

/** Find the send button (conditional — only after text exists). */
async function findSendButton(): Promise<string | null> {
  return resolveControl('sendButton', true);
}

// ---------------------------------------------------------------------------
// In-page collection script (status signals + raw prose), NO extraction here —
// extraction happens Node-side in src/providers/extraction.ts (testable).
// ---------------------------------------------------------------------------
const POLL_SCRIPT = `(() => {
  const body = document.body.innerText;

  // stop button + spinner signals
  let hasActiveStopButton = false;
  for (const btn of document.querySelectorAll('button')) {
    const rect = btn.querySelector('rect');
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    if ((rect || ariaLabel.includes('stop')) &&
        btn.offsetParent !== null && !btn.disabled) {
      hasActiveStopButton = true;
      break;
    }
  }
  const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;

  // collect RAW prose texts (filtering happens Node-side)
  const mainContent = document.querySelector('main') || document.body;
  const proseTexts = [];
  const proseHtmls = [];
  for (const el of mainContent.querySelectorAll('[class*="prose"]')) {
    if (el.closest('nav, aside, header, footer, form')) continue;
    const t = el.innerText.trim();
    if (t.length > 0) proseTexts.push(t);
    // P2 markdown: capture the LAST prose element's innerHTML for conversion
    proseHtmls.push(el.innerHTML);
  }

  return { hasActiveStopButton, hasLoadingSpinner, bodyText: body, proseTexts, proseHtmls };
})()`;

export class PerplexityDriver implements ChatDriver {
  readonly provider = 'perplexity' as const;

  async open(): Promise<TabSession> {
    // Reuse CometCDPClient.connect to ensure a live session on a perplexity tab.
    await cometClient.connect();
    const tabs = await cometClient.listTabsCategorized();
    const targetId = tabs.main?.id ?? undefined;
    return {
      provider: 'perplexity',
      tabId: targetId ?? 'unknown',
      targetId: targetId ?? '',
      cdpSessionId: 'comet-client',
      openedAt: new Date().toISOString(),
      state: 'connected',
    };
  }

  async ask(session: TabSession, prompt: string): Promise<{ receipt: DeliveryReceipt }> {
    const composer = await findComposer();
    if (!composer) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Could not find input element. Navigate to Perplexity first.',
        },
      };
    }

    // type (contenteditable first, textarea fallback) — same as CometAI.sendPrompt
    const typed = await evalValue(`(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return { success: false };
      if (el.isContentEditable || el.tagName === 'DIV') {
        const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
        editable.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(prompt)});
        return { success: true };
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.focus();
        el.value = ${JSON.stringify(prompt)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
      }
      return { success: false };
    })()`);
    if (typed?.success !== true) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Failed to type into input element',
        },
      };
    }

    const submitted = await this.submit(composer);
    return {
      receipt: {
        receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        status: submitted ? 'sent' : 'unknown', // uncertain delivery surfaced, never silently retried
        recordedAt: new Date().toISOString(),
        details: submitted ? `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"` : 'Submission uncertain',
      },
    };
  }

  /** Submit the current prompt — same strategy ladder as CometAI.submitPrompt. */
  private async submit(composer: string): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 500));

    // verify text landed
    const hasContent = await evalValue(`(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return false;
      const v = el.isContentEditable || el.tagName === 'DIV'
        ? el.innerText : (el.value || '');
      return v.trim().length > 0;
    })()`);
    if (hasContent !== true) return false;

    // Strategy 1: Enter key (most reliable for Perplexity)
    await evalValue(`(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
    await cometClient.pressKey('Enter');
    await new Promise((r) => setTimeout(r, 500));

    // check submitted (composer emptied or loading)
    const submitted = await evalValue(`(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (el) {
        const v = el.isContentEditable || el.tagName === 'DIV' ? el.innerText : (el.value || '');
        if (v.trim().length < 5) return true;
      }
      return document.querySelector('[class*="animate"]') !== null;
    })()`);
    if (submitted === true) return true;

    // Strategy 2: click submit button (from entry, with rebind)
    const sendSel = await findSendButton();
    if (sendSel) {
      const clicked = await evalValue(`(() => {
        const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
      if (clicked === true) {
        await new Promise((r) => setTimeout(r, 500));
        return true;
      }
    }

    // Last resort: Enter one more time
    await cometClient.pressKey('Enter');
    return true;
  }

  async poll(session: TabSession): Promise<PollResult> {
    // agent browsing URL (unchanged from CometAI.getAgentStatus)
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) agentBrowsingUrl = tabs.agentBrowsing.url;
    } catch { /* continue without URL */ }

    const raw = await cometClient.safeEvaluate(POLL_SCRIPT);
    const value = (raw?.result?.value ?? {}) as {
      hasActiveStopButton?: boolean;
      hasLoadingSpinner?: boolean;
      bodyText?: string;
      proseTexts?: string[];
      proseHtmls?: string[];
    };

    const bodyText = value.bodyText ?? '';
    const status = determineStatus({
      hasActiveStopButton: value.hasActiveStopButton === true,
      hasLoadingSpinner: value.hasLoadingSpinner === true,
      bodyText,
    });
    const { steps, currentStep } = extractSteps(bodyText);
    const extraction = status === 'completed' ? extractResponse(value.proseTexts ?? []) : null;
    // P2 markdown: convert the LAST prose container's innerHTML when completed
    const markdown = status === 'completed' && (value.proseHtmls?.length ?? 0) > 0
      ? htmlToMarkdown('perplexity', value.proseHtmls![value.proseHtmls!.length - 1])
      : null;

    return {
      state: status as ProviderState,
      steps,
      currentStep,
      response: extraction?.response ?? '',
      markdown,
      hasStopButton: value.hasActiveStopButton === true,
      agentBrowsingUrl,
      contentHash: extraction ? simpleHash(extraction.response) : undefined,
      extraction: extraction
        ? {
            joinedProseBlocks: extraction.joinedProseBlocks,
            truncatedFromEnd: extraction.truncatedFromEnd,
            dedupedByContainment: extraction.dedupedByContainment,
          }
        : undefined,
    };
  }

  async stop(session: TabSession): Promise<boolean> {
    const result = await cometClient.evaluate(`(() => {
      for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
        btn.click(); return true;
      }
      for (const btn of document.querySelectorAll('button')) {
        if (btn.querySelector('svg rect')) { btn.click(); return true; }
      }
      return false;
    })()`);
    return (result?.result?.value as boolean) ?? false;
  }

  async reset(session: TabSession): Promise<void> {
    // same as CometAI/old comet_ask newChat path: navigate to Perplexity home
    await cometClient.navigate('https://www.perplexity.ai/', true);
    await new Promise((r) => setTimeout(r, 1500));
  }

  async health(session: TabSession): Promise<HealthReport> {
    const e = entry();
    const checks: HealthReport['hookResolution'] = [];
    let healthy = true;
    for (const name of ['composer', 'sendButton', 'modelPicker', 'responseContainer'] as const) {
      const control = e?.controls[name];
      if (!control?.selector) continue;
      const resolved = await resolveWithRebind(
        (expr) => evalValue(expr),
        control.selector,
        control.fingerprint,
      );
      const ok = resolved !== null;
      checks.push({
        control: name,
        source: ok ? (resolved!.rebound ? 'known-selector' : 'known-selector') : (control.fingerprint ? 'override' : 'missing'),
      });
      if (!ok && name !== 'sendButton') healthy = false; // sendButton conditional
    }
    return {
      provider: 'perplexity',
      healthy,
      loginRequired: false,
      degraded: !healthy,
      hookResolution: checks,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Migration path: comet_* tools keep working; provider_* names arrive later. */
export const perplexityDriver = new PerplexityDriver();

// ---------------------------------------------------------------------------
// CometAI-compatible surface — the comet_* MCP tools call these; behavior is
// identical to the old CometAI (P1: "without changing user-visible behavior"),
// but resolution/extraction now flow through the registry + extraction module.
// ---------------------------------------------------------------------------

/** Old CometAI.getAgentStatus() shape, preserved for comet_poll/comet_ask. */
export interface LegacyStatus {
  status: 'idle' | 'working' | 'completed';
  steps: string[];
  currentStep: string;
  response: string;
  hasStopButton: boolean;
  agentBrowsingUrl: string;
}

/** compat: cometAI.sendPrompt(prompt) */
export async function legacySendPrompt(prompt: string): Promise<string> {
  const session = await perplexityDriver.open();
  const { receipt } = await perplexityDriver.ask(session, prompt);
  if (receipt.status === 'blocked') throw new Error(receipt.details ?? 'failed to send');
  return receipt.details ?? `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
}

/** compat: cometAI.getAgentStatus() — maps PollResult to the legacy status shape. */
export async function legacyGetAgentStatus(): Promise<LegacyStatus> {
  const session = await perplexityDriver.open();
  const poll = await perplexityDriver.poll(session);
  return {
    status: (poll.state === 'streaming' || poll.state === 'typing' ? 'working' : poll.state) as 'idle' | 'working' | 'completed',
    steps: poll.steps,
    currentStep: poll.currentStep,
    response: poll.response,
    hasStopButton: poll.hasStopButton,
    agentBrowsingUrl: poll.agentBrowsingUrl,
  };
}

/** compat: cometAI.stopAgent() */
export async function legacyStopAgent(): Promise<boolean> {
  const session = await perplexityDriver.open();
  return perplexityDriver.stop(session);
}
