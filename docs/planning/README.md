# Planning (comet-mcp)

Engine-side planning for work that **lands in this repository**.

The HTTP facade and product planning live in **[MrJ55/comet-api](https://github.com/MrJ55/comet-api)**.

## Active

| Doc | Purpose |
|---|---|
| [phase-0-library-api-tasks.md](./phase-0-library-api-tasks.md) | Granular Phase 0 tasks: library API, internal advancer, lifecycle freeze, 5-provider live gate — **facade unlock** |

## Rules

- Phase 0 code changes belong here, not in comet-api.
- Do not implement P5b `run_plan` / P7 here as part of Phase 0.
- Do not vendor this tree into comet-api; comet-api depends on this package.
- After Phase 0 exit criteria pass, mark facade unlocked in `docs/build-plan.md` and note it in comet-api `planning/progress.md`.
