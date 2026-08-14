# Phase 0 — Execution clarifications and runtime gates

This addendum supplements `phase-0-library-api-tasks.md`. It deliberately does **not** replace the canonical checklist or expand Phase 0 into P5b, P7, HTTP, or a second completion system.

## 1. Acceptance staging by PR

The original workstreams remain authoritative. Apply these acceptance boundaries:

| PR | Scope | Acceptance boundary |
|---|---|---|
| PR-1 | A1–A2 inventory and lifecycle docs | Documentation only; no claim of auto-advancement |
| PR-2 | B1–B3 library exports | A non-MCP script can import the library, dispatch an ask, receive `in_progress`, and read an ask snapshot. It may use a test/manual advance path. It does **not** claim completion without external advancement. |
| PR-3 | C1–C3 internal advancer | After `dispatchAsk`, with no client `provider_poll` or external `advanceAsk`, the ask reaches completed or a documented terminal outcome and the response is fetchable. |
| PR-4 | B4–B5 + D1–D4 | Stable tab/model errors, consumer smoke script, snapshot, idempotency, response, and abandon-vs-cancel behavior. |
| PR-5 | E1–E3 live gate | Provider-by-provider live/scripted evidence, latency, replay, follow-up, and failure-path results. |
| PR-6 | F1–F2 closeout | Build-plan update and consumer runbook; record the engine commit consumed by comet-api. |

Do not mark B5's auto-complete smoke acceptance complete during PR-2. It is an advancer acceptance and belongs to PR-3 or the later integrated gate.

## 2. One runtime owner

Phase 0 must expose one explicit engine runtime lifecycle, even if the final symbol names differ:

```text
startEngine(options?)
  → initializes/attaches the shared runtime
  → starts the internal PendingAsk advancer
  → starts or attaches to the existing soft-expiry/reaper machinery

stopEngine()
  → stops new scheduling
  → allows or cancels in-flight advancement according to policy
  → releases leases/timers cleanly
```

Requirements:

- MCP server startup calls the same runtime start path.
- A library consumer calls the same runtime start path.
- Repeated start is idempotent or returns a stable already-started result.
- Stop is idempotent.
- There is one owner for the advancer and one owner for reaper timers in the process.
- Completion is durably written before an ask is removed from the pending registry.
- Exact module/file names (`src/engine.ts` vs `src/engine/index.ts`, etc.) are implementation choices; the lifecycle contract is not.

## 3. Single-process ownership rule

Phase 0 assumes one Node process owns a browser profile/data directory and its engine runtime:

```text
one process → CDP pool + tab registry + PendingAsk advancer + reaper + event store
```

Do not design competing MCP and library processes for the same browser profile in Phase 0. If MCP and library calls coexist, they must share the same in-process runtime. Multi-process coordination, distributed leases, and horizontal scaling are out of scope.

Document the failure mode for a second process explicitly (`ENGINE_ALREADY_OWNED`, or equivalent) rather than allowing two advancers to compete silently.

## 4. Definition-of-done tiers

Use two labels so environmental provider failures do not obscure engine completion:

### Hard facade-unlock DoD

- Importable non-MCP library entrypoint.
- Runtime start/stop with one advancer/reaper owner.
- Internal advancement with zero client polls.
- Frozen status/snapshot contract and tests.
- Idempotent retry with no second send.
- At least one provider live gate, preferably Perplexity, plus mock/fixture coverage for the generic path.
- Clean response retrieval and failure/closed-tab behavior.
- Consumer runbook and smoke script.
- Build plan says P5b/P7 are deferred and facade Phase 0 is unlocked.

### Full Phase 0 provider badge

- Perplexity, Grok, Gemini, ChatGPT, and Claude live/scripted gates pass, or each exception has a documented environmental cause and issue/link.
- Follow-up regression coverage exists for at least Perplexity and one other provider.
- Latency/status/replay evidence is recorded per provider.

The hard DoD unblocks comet-api development. The full badge remains the release-quality target.

## 5. Documentation clarifications

- The canonical task list remains the execution checklist; this addendum supplies sequencing and runtime gates.
- Symbol maps may be a dedicated planning file or a PR description if the result is durable and reviewable.
- New module names are suggestions, not requirements.
- Do not add OpenAPI, HTTP routes, SSE, MCP-Bridge, broad tool calling, NotebookLM, or pi-livecraft implementation to Phase 0.
- Do not rewrite completion detection, the event store, the reaper, or P4 relay safety while exporting the library boundary.
- Keep the existing unit/live test bar green after each PR slice.

## 6. Handoff to comet-api

When hard DoD passes:

1. Record the exact comet-mcp commit SHA in the comet-api planning files.
2. Add the dependency by sibling `file:` reference for local work or a pinned git SHA for CI.
3. Point `comet-api/src/clients/comet-engine.ts` only at the documented library exports.
4. Do not import drivers, CDP clients, poll scripts, or event-store internals from comet-api.

## 7. Worker guardrail summary

For a small code worker:

- Read the existing `dispatchAsk`, `advanceAsk`, PendingAsk, reaper, and MCP startup paths before modifying anything.
- Make PR-1 docs-only and PR-2 export-only where possible.
- Make PR-3 the first place that can claim client-poll-free completion.
- If live browser access is unavailable, complete hard DoD with fixtures and record the blocker; do not fake a provider pass.
- Stop and ask for review if the change requires a second completion detector, second event store, HTTP route, P5b/P7 scheduler, or multi-process ownership scheme.
