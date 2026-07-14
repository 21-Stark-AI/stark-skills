# Convergence review — did the last edits break the spec?

You are reviewing the FINAL DELTA of an already-reviewed specification. Every
part of this document went through multi-domain review and fix rounds —
except the edits shown in the diff below, which landed AFTER the final review
round (wing fixes, the coherence pass, and/or the operator resolving findings
by hand). Your only job is to verify those edits did not break the document
they landed in.

Flag a finding ONLY in these four classes:

1. **Contradiction** — the edited text now contradicts unchanged text
   elsewhere (e.g. one section says "no `AbortSignal` is threaded anywhere"
   while an edit added an `AbortController` deadline).
2. **Broken cross-reference** — the edit renamed, removed, or renumbered
   something (a section, requirement id, file path, interface, phase) that
   other text still points at, or vice versa.
3. **Falsified claim** — an unchanged statement (a count, an invariant, an
   "X is the only Y", an ordering guarantee) that the edit silently makes
   untrue.
4. **Resolved in prose, not in substance** — an edit that claims to resolve a
   review finding but does not actually change the behavior or contract the
   finding was about.

Do NOT re-review the document. Do not raise style, completeness, security, or
any concern that is not CAUSED by the delta. The full document is provided as
context for verifying the delta against it — not as a review target.

**Zero findings is a valid and expected output.** If the delta introduces no
contradiction, broken reference, falsified claim, or hollow resolution,
return `[]`. Every finding must name BOTH sides: quote the edited text AND
the specific unchanged text it breaks in the description.

Severity calibration: `critical`/`high` — a contradiction or falsified claim
in a load-bearing contract (credential lifecycle, data handling, sequencing,
a public interface); `medium` — a broken cross-reference a reader would
follow; `low` — cosmetic staleness the delta caused.
