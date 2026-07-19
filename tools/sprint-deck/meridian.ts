// Meridian scrumban-report client + the report->deck-data mapping.
//
// The admin API (:8091) is VPC-internal, so a laptop run needs a port-forward:
//   kubectl port-forward -n meridian svc/meridian-api-admin 8091:8091
// then MERIDIAN_BASE=http://localhost:8091 and MERIDIAN_API_KEY=<key>.
// (Or point MERIDIAN_BASE at the web proxy /api/admin/scrumban-reports with a
// session cookie — heavier; the port-forward is the clean headless path.)
import type { CapacityRow, ReportEnvelope, StatCell, TeamDeckData } from './types.ts'

export interface MeridianConfig {
  base: string
  apiKey: string
}

export async function fetchReport(cfg: MeridianConfig, teamId: string, sprintId: number): Promise<ReportEnvelope> {
  const url = `${cfg.base}/api/v1/scrumban-reports/v2/${teamId}/${sprintId}?tier=full`
  const res = await fetch(url, { headers: { 'X-API-Key': cfg.apiKey } })
  if (!res.ok) throw new Error(`meridian report ${teamId}/${sprintId} failed ${res.status}: ${await res.text()}`)
  return (await res.json()) as ReportEnvelope
}

const set = (a: string[]) => new Set(a)
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—')

/**
 * Map a meridian report envelope to the deck data.
 *
 * IMPORTANT (data-gap honesty):
 *  - CAPACITY is a FIRST DRAFT. Meridian's capacity model can't yet see reduced
 *    TL allocation, reserve duty, or mid-sprint departures (allocation_pct is
 *    stuck at 100). Review `capacity` + set `capacity.note` per team until the
 *    meridian capacity model lands. `overrides` lets you inject the real values.
 *  - STORY POINTS come from meridian tickets' `estimate_points`; teams that
 *    don't estimate render "—" (correct — not a gap).
 */
export function toDeckData(
  title: string,
  team: string,
  env: ReportEnvelope,
  overrides?: Partial<CapacityRow>,
): TeamDeckData {
  const r = env.payload
  const led = r.companions.ledger
  const tickets = r.companions.tickets

  // ----- capacity (first draft from the heatmap) -----
  const head = r.companions.heatmap.head_count
  const workingDays = r.companions.heatmap.days.filter((d) => !d.non_work).length
  const vac = r.companions.heatmap.days.reduce((s, d) => s + d.planned + d.unplanned, 0)
  const supportPct = overrides?.supportPct ?? 0
  const teamCapacity = overrides?.teamCapacity ?? head
  const gross = overrides?.gross ?? teamCapacity * workingDays
  const supportDays = overrides?.supportDays ?? Math.round(gross * (supportPct / 100) * 10) / 10
  const vacations = overrides?.vacations ?? vac
  const net = overrides?.net ?? Math.round((gross - supportDays - vacations) * 10) / 10
  const capacity: CapacityRow = {
    teamCapacity,
    supportPct,
    vacations,
    workingDays: overrides?.workingDays ?? workingDays,
    gross,
    supportDays,
    net,
    note: overrides?.note,
  }

  // ----- flow stats (Plan = carried-in, Unplanned = started) -----
  const ci = set(led.carried_in_keys ?? [])
  const st = set(led.started_keys ?? [])
  const co = set(led.completed_keys ?? [])
  const donePlan = [...co].filter((k) => ci.has(k)).length
  const doneUnpl = co.size - donePlan
  const sp = (k: string) => tickets.find((t) => t.key === k)?.estimate_points ?? 0
  const spCi = [...ci].reduce((s, k) => s + sp(k), 0)
  const spSt = [...st].reduce((s, k) => s + sp(k), 0) + [...co].filter((k) => !ci.has(k) && !st.has(k)).reduce((s, k) => s + sp(k), 0)
  const spDonePlan = [...co].filter((k) => ci.has(k)).reduce((s, k) => s + sp(k), 0)
  const spDoneAll = [...co].reduce((s, k) => s + sp(k), 0)
  const hasPoints = spCi + spSt > 0
  const dash: StatCell = { plan: '—', unplanned: '—', total: '—', planPct: '—', unplannedPct: '—', totalPct: '—' }

  const issuesCount: StatCell = { plan: `${led.carried_in}`, unplanned: `${led.started}`, total: `${led.carried_in + led.started}` }
  const issuesDone: StatCell = {
    plan: `${donePlan}`, planPct: pct(donePlan, led.carried_in),
    unplanned: `${doneUnpl}`, unplannedPct: pct(doneUnpl, led.started),
    total: `${led.completed}`, totalPct: pct(led.completed, led.carried_in + led.started),
  }
  const storyPoints: StatCell = hasPoints
    ? { plan: `${spCi}`, unplanned: `${spSt}`, total: `${spCi + spSt}` }
    : dash
  const completedPoints: StatCell = hasPoints
    ? { plan: `${spDonePlan}`, planPct: pct(spDonePlan, spCi), unplanned: `${spDoneAll - spDonePlan}`, unplannedPct: pct(spDoneAll - spDonePlan, spSt), total: `${spDoneAll}`, totalPct: pct(spDoneAll, spCi + spSt) }
    : dash

  const cancelledKeys = set(led.cancelled_keys ?? [])
  const cancPlan = [...cancelledKeys].filter((k) => ci.has(k)).length
  const cancelled: StatCell = { plan: `${cancPlan}`, unplanned: `${led.cancelled - cancPlan}`, total: `${led.cancelled}` }

  const blockedKeys = tickets.filter((t) => t.status === 'Blocked').map((t) => t.key)
  const blkPlan = blockedKeys.filter((k) => ci.has(k)).length
  const blocked: StatCell = { plan: `${blkPlan}`, unplanned: `${blockedKeys.length - blkPlan}`, total: `${blockedKeys.length}` }

  // ----- goals -----
  const goals = env.goals ?? []
  const goalsAchieved = goals
    .filter((g) => g.linked_total > 0 && g.done_by_window_end >= g.linked_total)
    .map((g) => ({ key: g.key, text: `${g.summary} (${g.done_by_window_end}/${g.linked_total})` }))
  const goalsInProgress = goals
    .filter((g) => !(g.linked_total > 0 && g.done_by_window_end >= g.linked_total))
    .map((g) => ({ key: g.key, text: `${g.summary} (${g.done_by_window_end}/${g.linked_total})` }))

  // ----- shipped (AI highlights when present; else the completed tickets) -----
  const hl = r.highlights
  const shipped =
    env.highlights_status === 'present' && hl
      ? hl.shipped.map((s) => ({ text: s.text, key: s.refs.find((x) => x.ticket_key)?.ticket_key ?? '' })).filter((s) => s.key)
      : tickets.filter((t) => t.state === 'done').slice(0, 8).map((t) => ({ text: t.key, key: t.key }))

  // ----- insights (seed; author refines) -----
  const insights = [
    `Delivered ${led.completed} items (${issuesDone.totalPct} of ${led.carried_in + led.started} inflow); ${led.started} unplanned pulled in-sprint vs ${led.carried_in} carried in.`,
    hasPoints ? `Story points on ${tickets.filter((t) => t.estimate_points != null).length} of ${tickets.length} tickets.` : `No story-point estimation — flow tracked by item count.`,
  ]
  if (led.cancelled + led.carried_out > 0) insights.push(`WIP churn: ${led.carried_out} carried out + ${led.cancelled} cancelled.`)

  return { team, title, capacity, issuesCount, storyPoints, issuesDone, completedPoints, cancelled, blocked, goalsAchieved, goalsInProgress, shipped, insights }
}
