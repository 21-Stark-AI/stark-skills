# PROGRESS.md Template

The single evolving done-vs-todo tracker per task. Rewritten **wholesale**
on every save (history lives in the handover chain, not here). Written for
the next agent session, not for a human reviewer. **≤ 50 lines.**

```markdown
# {task-slug} — progress

Updated: {ISO timestamp} (handover_{N}.md)

## Done

- [x] {completed item — outcome, not activity: "lib + CLI pass 21/21 tests"}
- [x] {…}

## In Progress

- [ ] {item mid-flight — exact state + what remains}

## Next

- [ ] {first thing the next session does — concrete, startable}
- [ ] {…in priority order}

## Open Questions

- {unresolved decision or unknown; "none" if clear}

## Decisions

- {settled choice the next session must not re-open}: {one-line why}
```

## Rules

- **Next is the contract**: resume recreates these as session tasks in
  order. Each item must be startable without interpretation.
- Done items are outcomes with evidence, compressed — one line each. Prune
  aggressively; when Done outgrows the file, collapse older items into a
  single "earlier: …" line (the chain has the detail).
- Never delete Open Questions silently — resolve them into Decisions or
  Done.
- If the file exceeds 50 lines, cut Done first, never Next.
