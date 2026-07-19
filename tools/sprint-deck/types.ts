// Minimal shapes for the meridian scrumban-report payload (only the fields the
// deck generator reads) and the Google Slides request/config types.
// The full report schema lives in the meridian backend
// (internal/scrumbanreport/types); we intentionally type only what we consume.

export interface HeatmapDay {
  date: string
  weekday: number
  worked: number
  planned: number
  unplanned: number
  non_work: boolean
}

export interface FlowLedger {
  carried_in: number
  started: number
  completed: number
  cancelled: number
  carried_out: number
  carried_in_keys?: string[]
  started_keys?: string[]
  completed_keys?: string[]
  cancelled_keys?: string[]
}

export interface Ticket {
  key: string
  type: string // story | task | bug | … (lowercase)
  status: string
  state: string // done | in_progress | cancelled
  estimate_points: number | null
}

export interface GoalLink {
  key: string
  status: string
  status_category: string
  in_window: boolean
}
export interface SprintGoal {
  key: string
  summary: string
  status: string
  status_category: string
  fix_versions?: string[]
  done_by_window_end: number
  linked_total: number
}

export interface HighlightRef {
  kind: string
  ticket_key?: string
}
export interface HighlightItem {
  text: string
  refs: HighlightRef[]
}
export interface Highlights {
  summary: string
  shipped: HighlightItem[]
  flowCallouts?: HighlightItem[]
  notablePrs?: HighlightItem[]
}

export interface ScrumbanReport {
  team_name: string
  sprint_label: string
  sprint_start_at: string
  sprint_end_at: string
  sprint_state: string
  companions: {
    heatmap: { head_count: number; days: HeatmapDay[] }
    ledger: FlowLedger
    tickets: Ticket[]
  }
}

// The read endpoint wraps the report in an envelope with the goals + highlights
// siblings (both computed read-time, not stored in the report JSONB).
export interface ReportEnvelope {
  payload: ScrumbanReport & { highlights?: Highlights }
  highlights_status: string
  goals?: SprintGoal[]
}

// ---- deck model ----

export interface CapacityRow {
  teamCapacity: number
  supportPct: number
  vacations: number
  workingDays: number
  gross: number
  supportDays: number
  net: number
  /** When set, rendered as an italic footnote under the capacity table (roster
   * reality that meridian's capacity model can't yet see). */
  note?: string
}

export interface StatCell {
  plan: string
  unplanned: string
  total: string
  planPct?: string
  unplannedPct?: string
  totalPct?: string
}

export interface TeamDeckData {
  team: string
  title: string // e.g. "Cloud"
  capacity: CapacityRow
  issuesCount: StatCell
  storyPoints: StatCell
  issuesDone: StatCell
  completedPoints: StatCell
  cancelled: StatCell
  blocked: StatCell
  goalsAchieved: Array<{ key: string; text: string }>
  goalsInProgress: Array<{ key: string; text: string }>
  shipped: Array<{ text: string; key: string }>
  insights: string[]
}

// A single Slides API request (loosely typed — the API validates).
export type SlidesRequest = Record<string, unknown>
