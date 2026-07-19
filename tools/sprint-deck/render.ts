// The report-data -> Slides batchUpdate mapping. Ported from the hand-authored
// generation used to build the first Infra Scrumban deck; each builder emits the
// requests that repopulate ONE duplicated template slide for a team.
//
// The generator DUPLICATES two template slides per team (KPI + Highlights) with
// mapped element ids, then these builders overwrite the cell/text content. The
// template owns all styling, geometry, and the retro scaffolding (Insights /
// Corrective Actions labels) — we only replace values, so the deck's look is
// whatever the template says.
import type { SlidesRequest, TeamDeckData, StatCell } from './types.ts'

const INK = { red: 0.05882353, green: 0.09019608, blue: 0.16470589 }
const GRAY = { red: 0.35, green: 0.4, blue: 0.5 }
const BLUE = { red: 0.23137255, green: 0.50980395, blue: 0.9647059 }
const JIRA = 'https://evinced.atlassian.net/browse'

// Element-id suffix scheme for a team's duplicated slides. `p` is a per-team
// prefix (e.g. "cloud", "ma"); these must match the objectIds map passed to the
// duplicateObject requests in deck.ts.
export interface TeamSlideIds {
  kpiTitle: string
  capTable: string
  statTable: string
  goalsBox: string
  hlTitle: string
  cards: string[] // up to 8
  insightsBox: string
}

const link = (url: string) => ({ link: { url } })
const solid = (c: unknown) => ({ solidFill: { color: { rgbColor: c } } })

function cellText(tbl: string, r: number, c: number, text: string, pct = false): SlidesRequest[] {
  const cellLocation = { rowIndex: r, columnIndex: c }
  return [
    { deleteText: { objectId: tbl, cellLocation, textRange: { type: 'ALL' } } },
    { insertText: { objectId: tbl, cellLocation, text } },
    {
      updateTextStyle: {
        objectId: tbl, cellLocation, textRange: { type: 'ALL' },
        style: { fontFamily: 'Inter', fontSize: { magnitude: pct ? 10 : 11.5, unit: 'PT' }, bold: !pct, foregroundColor: { opaqueColor: { rgbColor: pct ? GRAY : INK } } },
        fields: 'fontFamily,fontSize,bold,foregroundColor',
      },
    },
    { updateParagraphStyle: { objectId: tbl, cellLocation, textRange: { type: 'ALL' }, style: { alignment: 'CENTER' }, fields: 'alignment' } },
  ]
}

// deleteText on an empty cell errors; the template cells always have content
// (they were populated once), so deleteText+insert is safe on a real template.

function setTitle(oid: string, text: string): SlidesRequest[] {
  return [
    { deleteText: { objectId: oid, textRange: { type: 'ALL' } } },
    { insertText: { objectId: oid, text } },
    { updateTextStyle: { objectId: oid, textRange: { type: 'ALL' }, style: { fontFamily: 'Inter', fontSize: { magnitude: 29, unit: 'PT' }, bold: true, foregroundColor: { opaqueColor: { rgbColor: INK } } }, fields: 'fontFamily,fontSize,bold,foregroundColor' } },
    { updateParagraphStyle: { objectId: oid, textRange: { type: 'ALL' }, style: { alignment: 'START' }, fields: 'alignment' } },
  ]
}

function statRow(tbl: string, row: number, s: StatCell, hasPct: boolean): SlidesRequest[] {
  const out: SlidesRequest[] = []
  out.push(...cellText(tbl, row, 1, s.plan))
  out.push(...cellText(tbl, row, 3, s.unplanned))
  out.push(...cellText(tbl, row, 5, s.total))
  if (hasPct) {
    out.push(...cellText(tbl, row, 2, s.planPct ?? '—', true))
    out.push(...cellText(tbl, row, 4, s.unplannedPct ?? '—', true))
    out.push(...cellText(tbl, row, 6, s.totalPct ?? '—', true))
  }
  return out
}

/** Build all requests to repopulate one team's KPI slide. */
export function renderKpi(ids: TeamSlideIds, d: TeamDeckData): SlidesRequest[] {
  const out: SlidesRequest[] = []
  out.push(...setTitle(ids.kpiTitle, `${d.title} KPI S14 + Goals`))

  // capacity value column (rows 1,2,3,4,6,7,8)
  const cap = d.capacity
  const capVals: Array<[number, string]> = [
    [1, `${cap.teamCapacity}`], [2, `${cap.supportPct}`], [3, `${cap.vacations}`], [4, `${cap.workingDays}`],
    [6, `${cap.gross}`], [7, `${cap.supportDays}`], [8, `${cap.net}`],
  ]
  for (const [r, v] of capVals) out.push(...cellText(ids.capTable, r, 1, v))

  // stats
  out.push(...statRow(ids.statTable, 1, d.issuesCount, false))
  out.push(...statRow(ids.statTable, 2, d.storyPoints, false))
  out.push(...statRow(ids.statTable, 3, d.issuesDone, true))
  out.push(...statRow(ids.statTable, 4, d.completedPoints, true))
  out.push(...statRow(ids.statTable, 5, d.cancelled, false))
  out.push(...statRow(ids.statTable, 6, d.blocked, false))

  // goals box
  const lines: Array<{ text: string; kind: 'hdr' | 'goal' | 'desc' }> = []
  if (d.goalsAchieved.length) {
    lines.push({ text: 'ACHIEVED\n', kind: 'hdr' })
    for (const g of d.goalsAchieved) lines.push({ text: `[${g.key}] ${g.text}\n`, kind: 'goal' })
    lines.push({ text: '\n', kind: 'desc' })
  }
  if (d.goalsInProgress.length) {
    lines.push({ text: 'IN PROGRESS\n', kind: 'hdr' })
    for (const g of d.goalsInProgress) lines.push({ text: `[${g.key}] ${g.text}\n`, kind: 'goal' })
  }
  const goalText = lines.map((l) => l.text).join('')
  out.push({ deleteText: { objectId: ids.goalsBox, textRange: { type: 'ALL' } } })
  out.push({ insertText: { objectId: ids.goalsBox, text: goalText } })
  out.push({ updateTextStyle: { objectId: ids.goalsBox, textRange: { type: 'ALL' }, style: { fontFamily: 'Inter', fontSize: { magnitude: 13, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: INK } } }, fields: 'fontFamily,fontSize,foregroundColor' } })
  for (const h of ['ACHIEVED', 'IN PROGRESS']) {
    const a = goalText.indexOf(h)
    if (a >= 0) out.push({ updateTextStyle: { objectId: ids.goalsBox, textRange: { type: 'FIXED_RANGE', startIndex: a, endIndex: a + h.length }, style: { bold: true, fontSize: { magnitude: 12, unit: 'PT' } }, fields: 'bold,fontSize' } })
  }
  for (const g of [...d.goalsAchieved, ...d.goalsInProgress]) {
    const a = goalText.indexOf(g.key)
    if (a >= 0) out.push({ updateTextStyle: { objectId: ids.goalsBox, textRange: { type: 'FIXED_RANGE', startIndex: a, endIndex: a + g.key.length }, style: { link: link(`${JIRA}/${g.key}`), foregroundColor: { opaqueColor: { rgbColor: BLUE } } }, fields: 'link,foregroundColor' } })
  }
  return out
}

/** Build all requests to repopulate one team's Highlights slide. */
export function renderHighlights(ids: TeamSlideIds, d: TeamDeckData): SlidesRequest[] {
  const out: SlidesRequest[] = []
  out.push(...setTitle(ids.hlTitle, `${d.title} S14 — Sprint Highlights`))

  // cards (repopulate up to 8; extra cards left as-is — deck.ts deletes surplus)
  const n = Math.min(d.shipped.length, ids.cards.length)
  for (let i = 0; i < n; i++) {
    const { text, key } = d.shipped[i]
    const oid = ids.cards[i]
    const body = `${text}  (${key})`
    const ks = text.length + 2, kk = text.length + 3, ke = kk + key.length
    out.push({ deleteText: { objectId: oid, textRange: { type: 'ALL' } } })
    out.push({ insertText: { objectId: oid, text: body } })
    out.push({ updateTextStyle: { objectId: oid, textRange: { type: 'ALL' }, style: { fontFamily: 'Inter', fontSize: { magnitude: 10.5, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: INK } } }, fields: 'fontFamily,fontSize,foregroundColor' } })
    out.push({ updateTextStyle: { objectId: oid, textRange: { type: 'FIXED_RANGE', startIndex: ks, endIndex: ke + 1 }, style: { foregroundColor: { opaqueColor: { rgbColor: BLUE } } }, fields: 'foregroundColor' } })
    out.push({ updateTextStyle: { objectId: oid, textRange: { type: 'FIXED_RANGE', startIndex: kk, endIndex: ke }, style: { link: link(`${JIRA}/${key}`) }, fields: 'link' } })
  }

  // insights (bulleted)
  if (d.insights.length) {
    out.push({ insertText: { objectId: ids.insightsBox, text: d.insights.join('\n') } })
    out.push({ updateTextStyle: { objectId: ids.insightsBox, textRange: { type: 'ALL' }, style: { fontFamily: 'Inter', fontSize: { magnitude: 11, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: INK } } }, fields: 'fontFamily,fontSize,foregroundColor' } })
    out.push({ createParagraphBullets: { objectId: ids.insightsBox, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } })
  }
  return out
}
