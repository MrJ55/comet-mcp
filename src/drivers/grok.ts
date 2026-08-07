/**
 * Grok ChatDriver (P2) — first heterogeneous adapter, proving the discovery-to-runtime
 * pipeline against a materially different UI (P2 task list).
 *
 * Grok-specific behaviors captured during live discovery (2026-08-06, grok.com):
 *  - composer is a contenteditable div `[data-testid="chat-input"]` — type via
 *    execCommand insertText (same technique as Perplexity; validated live);
 *  - send button `[data-testid="chat-submit"]` renders ONLY after text is typed
 *    (conditional control — skipped by verify, exercised by ask);
 *  - **no stop button ever** on the Fast model — stop() is a no-op returning false;
 *    streaming/completion is signaled by the "Working for Xs" → "Worked for Xs"
 *    timing line (canvas-working-indicator), which Grok renders INSIDE the message;
 *  - one answer = one `[data-testid="assistant-message"]` element — extraction takes
 *    the LAST one and strips the timing line (src/providers/extraction.ts).
 *
 * Controls resolve through src/providers/entries/grok.json + ADR 0003 fingerprint
 * rebind, same as the Perplexity driver.
 */

import { cometClient } from '../cdp-client.js';
import type { EvaluateResult } from '../types.js';
import type {
  ChatDriver, PollResult, TabSession, HealthReport, ProviderState,
} from '../types/provider.js';
import type { DeliveryReceipt } from '../types/conversation.js';
import { loadEntry, resolveWithConfidence, recordSuccess, recordFailure, writeEntry } from '../core/registry.js';
import { resolveWithRebind } from '../core/fingerprint.js';
import { extractGrokResponse, determineGrokStatus } from '../providers/extraction.js';

const entry = () => loadEntry('grok');

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
async function resolveControl(name: 'composer' | 'sendButton' | 'modelPicker' | 'newChat' | 'responseContainer', conditional = false): Promise<string | null> {
  const e = entry();
  if (!e) return null;
  const { selector, control } = resolveWithConfidence(e, name);
  if (!selector) return null;

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

  // genuine miss — record failure (conditional controls skipped)
  if (!conditional && control) {
    const { control: updated } = recordFailure(control);
    (e.controls as any)[name] = updated;
    writeEntry(e);
  }
  return null;
}

/** Find the Grok composer (entry selector first, role=textbox fallback). */
async function findComposer(): Promise<string | null> {
  const entrySel = await resolveControl('composer');
  if (entrySel) return entrySel;
  const hit = await evalValue(`document.querySelector('[role="textbox"]') !== null`);
  return hit === true ? '[role="textbox"]' : null;
}

/** Find the send button (conditional — only after text exists). */
async function findSendButton(): Promise<string | null> {
  return resolveControl('sendButton', true);
}

// ---------------------------------------------------------------------------
// In-page collection script (Grok) — status signals + assistant-message texts.
// Extraction happens Node-side in src/providers/extraction.ts (testable).
// ---------------------------------------------------------------------------
const POLL_SCRIPT = `(() => {
  const body = document.body.innerText;
  const msgs = [...document.querySelectorAll('[data-testid="assistant-message"]')];
  const texts = msgs.map(el => (el.innerText || '').trim()).filter(t => t.length > 0);
  return { bodyText: body, assistantMessages: texts };
})()`;

export class GrokDriver implements ChatDriver {
  readonly provider = 'grok' as const;

  async open(): Promise<TabSession> {
    // Connect to the grok.com tab specifically (not the auto-selected "best" tab).
    const targets = await cometClient.listTargets();
    const grokTab = targets.find((t) => t.type === 'page' && /grok\.com/.test(t.url));
    if (grokTab) await cometClient.connect(grokTab.id);
    return {
      provider: 'grok',
      tabId: grokTab?.id ?? 'unknown',
      targetId: grokTab?.id ?? '',
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
          details: 'Could not find Grok composer. Is the grok.com tab open and logged in?',
        },
      };
    }

    // type into the contenteditable composer (focus editable child, execCommand)
    const typed = await evalValue(`(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return { success: false };
      const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
      editable.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      return { success: true };
    })()`);
    if (typed?.success !== true) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Failed to type into Grok composer',
        },
      };
    }

    // submit — send button (conditional) or Enter fallback
    await new Promise((r) => setTimeout(r, 500));
    let submitted = false;
    const sendSel = await findSendButton();
    if (sendSel) {
      const clicked = await evalValue(`(() => {
        const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
      submitted = clicked === true;
    }
    if (!submitted) {
      await evalValue(`(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
      await cometClient.pressKey('Enter');
      submitted = true;
    }

    return {
      receipt: {
        receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        status: submitted ? 'sent' : 'unknown',
        recordedAt: new Date().toISOString(),
        details: submitted ? `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"` : 'Submission uncertain',
      },
    };
  }

  async poll(session: TabSession): Promise<PollResult> {
    const raw = await cometClient.safeEvaluate(POLL_SCRIPT);
    const value = (raw?.result?.value ?? {}) as {
      bodyText?: string;
      assistantMessages?: string[];
    };
    const bodyText = value.bodyText ?? '';
    const messages = value.assistantMessages ?? [];

    const state = determineGrokStatus({ bodyText, lastMessageLen: messages[messages.length - 1]?.length ?? 0 });
    const extraction = state === 'completed' ? extractGrokResponse(messages) : null;

    return {
      state: state as ProviderState,
      steps: [],
      currentStep: '',
      response: extraction?.response ?? '',
      // Verified finding: Grok Fast model NEVER renders a stop button.
      hasStopButton: false,
      agentBrowsingUrl: '',
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
    // Verified discovery finding: Grok Fast model never renders a stop button.
    // No-op — the fabric must not assume a stop control exists.
    return false;
  }

  async reset(session: TabSession): Promise<void> {
    // new chat via the entry control, fallback to navigate
    const newChatSel = await resolveControl('newChat', true);
    if (newChatSel) {
      const clicked = await evalValue(`(() => {
        const b = document.querySelector(${JSON.stringify(newChatSel)});
        if (!b) return false; b.click(); return true;
      })()`);
      if (clicked === true) {
        await new Promise((r) => setTimeout(r, 1200));
        return;
      }
    }
    await cometClient.navigate('https://grok.com/', true);
    await new Promise((r) => setTimeout(r, 1500));
  }

  async health(session: TabSession): Promise<HealthReport> {
    const e = entry();
    const checks: HealthReport['hookResolution'] = [];
    let healthy = true;
    for (const name of ['composer', 'sendButton', 'modelPicker', 'newChat', 'responseContainer'] as const) {
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
        source: ok ? 'known-selector' : (control.fingerprint ? 'override' : 'missing'),
      });
      if (!ok && name !== 'sendButton') healthy = false; // sendButton conditional
    }
    return {
      provider: 'grok',
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

export const grokDriver = new GrokDriver();
