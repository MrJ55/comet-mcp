# Planning (comet-mcp)

Engine-side planning for work that **lands in this repository**.

The HTTP facade and product planning live in **[MrJ55/comet-api](https://github.com/MrJ55/comet-api)**.

## Active

| Doc | Purpose |
|---|---|
| [phase-0-library-api-tasks.md](./phase-0-library-api-tasks.md) | **Canonical checklist** — library API, internal advancer, lifecycle freeze, extraction invariant, contracts (`askId`, status, idempotency) |
| [phase-0-library-api-tasks-addendum.md](./phase-0-library-api-tasks-addendum.md) | **Sequencing & runtime gates** — PR acceptance boundaries, hard vs full DoD, process ownership, comet-api handoff |

### Precedence

- **Product contracts** (`askId`, status vocabulary, idempotency fingerprint fields, extraction invariant, error codes): the **task list** wins.
- **PR acceptance order, process ownership, hard vs full DoD tiers, handoff steps**: the **addendum** wins.
- If both speak to the same topic, follow the more specific rule; do not invent a third interpretation.

## Rules

- Phase 0 code changes belong here, not in comet-api.
- Do not implement P5b `run_plan` / P7 here as part of Phase 0.
- Do not vendor this tree into comet-api; comet-api depends on this package.
- **Hard facade-unlock DoD** (see addendum) unblocks comet-api; the full five-provider badge is the release-quality target.
- After hard DoD passes, mark facade unlocked in `docs/build-plan.md` and note it in comet-api `planning/progress.md` (addendum §6).
