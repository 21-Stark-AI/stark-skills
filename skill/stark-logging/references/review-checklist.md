# Reviewing logs — the checklist

Apply this to any diff that adds or changes logging. Each item is a **pass
criterion** — verify it holds. Where it **doesn't**, that's your reject
condition: leave a comment and ask for the fix. Ordered by how often each one
catches something real.

## Structure — is it an event or a sentence?

- [ ] **Message is a constant.** No `fmt.Sprintf`, `%s`, `%v`, or `+` building
  the message string. Variable data lives in fields, not the message.
  → *"Move `%s` into a field so these lines aggregate: `log.Info("user synced", "user_id", id)`."*
- [ ] **Fields are typed, not stringified.** `"count", n` not `"count", strconv.Itoa(n)`;
  `"duration_ms", d.Milliseconds()` not `"took", d.String()`.
- [ ] **Keys match the repo's names.** Same concept → same key everywhere
  (`error`, `run_id`, `resource_id`, `duration_ms`, `attempt`, `count`, `status`).
  Flag `userId` vs `user_id` vs `uid` drift.

## Level — audience and action

- [ ] **Level matches the audience+action table**, not the emotional weight.
- [ ] **No handled condition at ERROR.** 404-not-found, `context.Canceled` on
  shutdown, retried-then-succeeded, skipped-malformed-record → WARN or INFO.
  Test: *"did the operation fail, or did we handle it?"* Handled → not ERROR.
  (Levels label events; paging is an SLO/metrics decision, not "an ERROR fired.")
- [ ] **No failure buried at INFO/DEBUG.** A real lost-work failure must be ERROR.
- [ ] **INFO reads as a story.** Only lifecycle + notable state changes at INFO.
  Per-item, per-iteration, per-page detail → DEBUG.

## Handling — logged once, in the right place

- [ ] **Not logged *and* returned.** Deep code wraps + returns
  (`fmt.Errorf("...: %w", err)`); the boundary that handles/swallows logs it once.
  Flag any `log.Error(err); return err`.
- [ ] **The boundary actually logs it.** An error swallowed silently (returned as
  `nil`, or `_ =`) with no log is the opposite failure — flag that too.
- [ ] **Context is bound once, not retyped.** Operation-scoped `With(...)` at the
  top; child lines inherit `run_id`/`operation`/subject. Flag hand-copied context.

## Actionability — could on-call act on it at 3am?

- [ ] **Failure lines carry the error.** `"error", err` present on every failure.
- [ ] **Failure lines carry the subject.** *Which* resource/user/request failed
  (`resource_id`, `user_id`, `request_id`) — a stable id, not PII.
- [ ] **Operations carry outcome + cost.** A canonical completion line with
  `duration_ms`, counts (`written`/`skipped`/`failed`), and `status`.
- [ ] **Message names the operation.** `"group write failed"` not `"error"` /
  `"failed"` / `"oops"`.

## Safety — nothing that shouldn't be in a log

- [ ] **No secrets.** Tokens, passwords, API keys, auth headers, cookies,
  private keys, connection strings — kept out of fields, messages, *and* error
  strings. A handler denylist is a backstop, not a license to pass them.
- [ ] **No PII beyond what's needed.** Log a stable id (`user_id`), not emails,
  names, or full profiles; not full request/response bodies.
- [ ] **No giant payloads.** Truncate/size-cap large values; don't dump blobs.
- [ ] **No log injection.** User-controlled data (incl. the message) is escaped
  for newlines/control chars so it can't forge extra log lines — put it in
  fields, not the message string.

## Volume — will it flood?

- [ ] **No unbounded per-item logging at INFO+** inside a loop over N records.
  Summarize; sample or rate-limit hot paths.
- [ ] **No duplicate lines** for the same event across layers (see logged-once).

## Wiring — the plumbing is right

- [ ] **Logger is injected, not global/package-level ad-hoc.** Passed in / on the
  struct, so level, sinks, and context are controllable and testable.
- [ ] **Levels are configurable** (env/flag), not hardcoded.
- [ ] **A machine-readable sink exists** (JSON/JSONL) wherever logs are shipped or
  retained — not only pretty console text.

---

## Comment templates

Keep review comments specific and fix-shaped:

> **Message carries data.** `log.Info(fmt.Sprintf("synced %d users", n))` won't
> aggregate — every line is a unique string. Make it
> `log.Info("users synced", "count", n)`.

> **Wrong level.** A retried-then-recovered timeout isn't ERROR (it'd page
> on-call for a non-event). This is WARN — unexpected but handled.

> **Logged twice.** You log here *and* return the error; the caller logs it
> again. Wrap and return (`fmt.Errorf("fetch groups: %w", err)`) and let the
> boundary log it once.

> **Not actionable.** `log.Error("failed")` — which operation, which resource,
> what error? Add `"error", err` and the subject id.

> **Secret in log.** `"token", tok` will hit the sink. Drop it, or redact at the
> handler (denylist `token`/`authorization`/…).
