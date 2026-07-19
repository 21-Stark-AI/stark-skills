# sprint-deck

Generate a Scrumban **sprint-review deck** from meridian, one KPI + Highlights
slide pair per team, in your template's styling.

It reads the meridian scrumban-report API (which already computes the flow
ledger, capacity heatmap, tickets, read-time **goals**, and AI **highlights**)
and renders it into a copy of a template Google Slides deck. The heavy lifting —
what used to be hand-built per team — is the `report → batchUpdate` mapping in
`render.ts`.

## What it does per team

1. `GET /api/v1/scrumban-reports/v2/{teamUuid}/{sprintId}` → the report envelope.
2. `toDeckData` (`meridian.ts`) maps it to the deck model: capacity, the
   Plan/Unplanned/Total flow stats, goals (achieved / in-progress), shipped
   cards (AI highlights when the team is consented, else completed tickets), and
   seed insights.
3. Duplicates the two template slides, repopulates by element id, links every
   Jira key.

## Run

```bash
# 1. reach the meridian admin API (VPC-internal) via a port-forward
kubectl port-forward -n meridian svc/meridian-api-admin 8091:8091 &

# 2. auth Google (Drive + Slides scope; one-time)
gcloud auth login --enable-gdrive-access

# 3. generate
export MERIDIAN_API_KEY=…              # the NIGHT_WATCH_API_KEY
export MERIDIAN_BASE=http://localhost:8091
node --experimental-strip-types sprint-deck.ts \
  --sprint 11342 \
  --teams cloud,manual-auditor,ai-devex \
  --title "Infra 2026S14 (Scrumban)"
```

Prints the deck URL.

## Adapting the template

`config.ts` `INFRA_TEMPLATE` pins the template deck id + the element ids inside
its two source slides. To fork the template, duplicate the deck, then:

```bash
node --experimental-strip-types sprint-deck.ts --inspect <newDeckId>
```

and copy the printed ids into `INFRA_TEMPLATE`. Add teams to the `TEAMS` map
(meridian `public.teams.id` UUID + display title).

## Definitions

- **Issue** = a **Task or Bug** only. The flow ledger's lane keys include epics
  and goals (containers, not discrete work); `toDeckData` filters every lane to
  the Task/Bug set from the tickets companion so counts reflect real work items.
- **Plan** = `carried_in` = already in progress (had a `started_at`) *before* the
  window opened. **Unplanned** = `started` = got its `started_at` *during* the
  window. For a kanban team with no sprint commitment, "unplanned" is a **proxy
  for pulled-in-mid-sprint** — not a true "wasn't committed"; a backlog item the
  team always meant to do but started this window still counts as unplanned.

## Known limits (by design, until the meridian source is fixed)

- **Capacity is a FIRST DRAFT.** Meridian's capacity model can't yet see reduced
  TL allocation, reserve duty, or mid-sprint departures (`allocation_pct` is
  stuck at 100). Review each team's capacity table and add a roster footnote
  before sharing. Pass real values via `toDeckData(..., overrides)` once known.
- **Story points** come from `ticket.estimate_points`; teams that don't estimate
  render "—" (correct, not a gap).
- **Goals** only appear when tagged with dated `26SNN` fixVersions (the meridian
  read-time windowing rule). Untagged-goal teams get an empty goals box.
- **AI highlights** need the team on `SCRUMBAN_HIGHLIGHTS_ALLOWED_TEAMS`; a
  non-consented team falls back to listing its completed tickets.

## Not built yet

- Insights/Corrective Actions are seeded (insights) / left blank (corrective) —
  authored per sprint. A future step could draft correctives from the flow
  signals.
- No cron/Slack wiring — this is the CLI rung. See the meridian runbook for the
  automation ladder.
