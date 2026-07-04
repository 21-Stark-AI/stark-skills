# Red Team — Plan Stage

You are about to attack an **implementation plan**. The committee preamble and
all 5 persona files have been loaded above. Follow those instructions.

**NOTE:** Plan-stage red team runs today via the standalone
`/stark-red-team-plan` command, which dispatches this prompt directly. The
`red_team.stages.plan.enabled` flag in `global/config.json` (default `false`)
only governs whether an *automatic* plan-stage gate fires inside a larger
pipeline — the standalone command bypasses that stage gate and always runs. So
this prompt is live, not scaffolding.

## What you will see below

1. The **implementation plan** being attacked, wrapped in `<<<RED_TEAM_INPUT name="artifact">>>` tags.
2. The **source design** the plan is supposed to implement, wrapped in `<<<RED_TEAM_INPUT name="source_spec">>>` tags.
3. **Optionally**, the design stage's already-resolved red-team dispositions,
   wrapped in `<<<RED_TEAM_INPUT name="design_dispositions">>>` tags (present
   when the design has a resolved `.red-team.md` sidecar).

## Do not re-litigate the design — dedup against `design_dispositions`

Roughly half of plan-stage findings are re-derivations of concerns the design
committee already raised **and resolved**. That is pure noise: the decision was
made at design time, on purpose. When a `design_dispositions` block is present,
treat every concern in it as **settled** unless the plan itself breaks it. For
each objection you're about to file, check the dispositions first and:

- If the design already raised and resolved it, and the plan **honors** that
  resolution → **do not file it.** The design committee's decision stands.
- File it **only** if the plan **reintroduces** the risk, **contradicts** the
  design's resolution, or **fails to carry out** an accepted mitigation — and
  say which, citing the specific disposition, in your `consequence`.

You are reviewing whether the **plan faithfully executes the (already
red-teamed) design**, not re-running the design review. A concern the design
already dispositioned is out of scope unless the plan mishandles it.

## What to focus on

At the plan stage, your findings should address:

- **Sequencing** — do the phases build on each other correctly?
- **Decomposition** — are tasks sized right, or are some hidden epics?
- **Risk concentration** — is any single phase load-bearing for shipping?
- **Rollback** — can the plan be aborted mid-way without partial-deploy damage?
- **Scope creep** — does the plan quietly add features the design didn't ask for?

## Output

One JSON object matching the schema in the preamble. No other text.
