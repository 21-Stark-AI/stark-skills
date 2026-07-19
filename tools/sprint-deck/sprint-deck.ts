#!/usr/bin/env node
/**
 * sprint-deck — generate a Scrumban sprint-review deck from meridian.
 *
 * For each team it: fetches the meridian scrumban report, maps it to deck data
 * (see meridian.ts `toDeckData`), duplicates the two template slides, and
 * repopulates them. Output: a Google Slides deck URL.
 *
 * Usage:
 *   node --experimental-strip-types sprint-deck.ts \
 *     --sprint 11342 --teams cloud,manual-auditor,ai-devex \
 *     --title "Infra 2026S14 (Scrumban)"
 *
 * Env:
 *   MERIDIAN_BASE      admin API base (default http://localhost:8091 — needs a
 *                      `kubectl port-forward -n meridian svc/meridian-api-admin 8091:8091`)
 *   MERIDIAN_API_KEY   the X-API-Key (NIGHT_WATCH_API_KEY)
 *   GCP_QUOTA_PROJECT  quota project for Slides ADC (default meridian-platform-21s)
 *   GOOGLE_ACCESS_TOKEN  optional; else `gcloud auth print-access-token` is used
 *
 * Inspect a template's ids:
 *   node --experimental-strip-types sprint-deck.ts --inspect <deckId>
 *
 * NOTE — capacity is a FIRST DRAFT (meridian can't yet see reduced TL/reserve/
 * departures). Review each team's capacity table + set a footnote before sharing.
 */
import { INFRA_TEMPLATE, TEAMS, teamSlideIds } from './config.ts'
import { batchUpdate, copyPresentation, getPresentation, resolveAuth } from './google.ts'
import { fetchReport, toDeckData } from './meridian.ts'
import { renderHighlights, renderKpi } from './render.ts'
import type { SlidesRequest } from './types.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function inspect(deckId: string) {
  const auth = resolveAuth(process.env.GCP_QUOTA_PROJECT ?? 'meridian-platform-21s')
  const p = await getPresentation(auth, deckId, 'slides(objectId,pageElements(objectId,shape(shapeType,text(textElements(textRun(content)))),table(rows,columns)))')
  for (const s of p.slides ?? []) {
    console.log(`\nSLIDE ${s.objectId}`)
    for (const e of s.pageElements ?? []) {
      const t = e.table ? `TABLE ${e.table.rows}x${e.table.columns}` : (e.shape?.shapeType ?? '?')
      const txt = (e.shape?.text?.textElements ?? []).map((x: any) => x.textRun?.content ?? '').join('').replace(/\n/g, ' ').slice(0, 40)
      console.log(`  ${e.objectId}\t${t}\t${txt}`)
    }
  }
}

async function main() {
  const inspectId = arg('inspect')
  if (inspectId) return inspect(inspectId)

  const sprintId = Number(arg('sprint'))
  const teamKeys = (arg('teams') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const deckTitle = arg('title') ?? `Scrumban Review ${sprintId}`
  if (!sprintId || teamKeys.length === 0) {
    console.error('usage: --sprint <id> --teams cloud,manual-auditor,... [--title "..."]')
    process.exit(2)
  }
  for (const k of teamKeys) if (!TEAMS[k]) throw new Error(`unknown team key "${k}" (known: ${Object.keys(TEAMS).join(', ')})`)

  const mer = { base: process.env.MERIDIAN_BASE ?? 'http://localhost:8091', apiKey: process.env.MERIDIAN_API_KEY ?? '' }
  if (!mer.apiKey) throw new Error('set MERIDIAN_API_KEY')
  const auth = resolveAuth(process.env.GCP_QUOTA_PROJECT ?? 'meridian-platform-21s')
  const tpl = INFRA_TEMPLATE

  console.log(`Copying template ${tpl.templateDeckId} -> "${deckTitle}"`)
  const deckId = await copyPresentation(auth, tpl.templateDeckId, deckTitle)

  for (const key of teamKeys) {
    const team = TEAMS[key]
    console.log(`\n[${team.title}] fetching report...`)
    const env = await fetchReport(mer, team.uuid, sprintId)
    const data = toDeckData(team.title, team.title, env)
    const ids = teamSlideIds(key.replace(/[^a-z0-9]/g, ''))

    // 1. duplicate the two template slides with mapped ids, move to the end
    const dup: SlidesRequest[] = [
      { duplicateObject: { objectId: tpl.kpiSlideId, objectIds: { [tpl.kpiSlideId]: `${ids.kpiTitle}_slide`, [tpl.kpi.title]: ids.kpiTitle, [tpl.kpi.capTable]: ids.capTable, [tpl.kpi.statTable]: ids.statTable, [tpl.kpi.goalsBox]: ids.goalsBox } } },
      { duplicateObject: { objectId: tpl.hlSlideId, objectIds: { [tpl.hlSlideId]: `${ids.hlTitle}_slide`, [tpl.hl.title]: ids.hlTitle, ...Object.fromEntries(tpl.hl.cards.map((c, i) => [c, ids.cards[i]])) } } },
    ]
    await batchUpdate(auth, deckId, dup)

    // 2. discover the duplicated Insights box on the highlights slide (empty box
    //    below the "Insights" label — it got a random id during duplication)
    const hlSlideId = `${ids.hlTitle}_slide`
    const p = await getPresentation(auth, deckId, 'slides(objectId,pageElements(objectId,transform,shape(text(textElements(textRun(content))))))')
    const hlSlide = (p.slides ?? []).find((s: any) => s.objectId === hlSlideId)
    const insightsBox = findInsightsBox(hlSlide)
    ids.insightsBox = insightsBox

    // 3. repopulate
    const reqs = [...renderKpi(ids, data), ...renderHighlights(ids, data)]
    // delete surplus highlight cards beyond the team's shipped count
    for (let i = data.shipped.length; i < ids.cards.length; i++) reqs.push({ deleteObject: { objectId: ids.cards[i] } })
    await batchUpdate(auth, deckId, reqs)
    console.log(`[${team.title}] done — ${data.shipped.length} shipped, ${data.goalsAchieved.length + data.goalsInProgress.length} goals; capacity DRAFT (review).`)
  }

  console.log(`\n✅ Deck: https://docs.google.com/presentation/d/${deckId}/edit`)
  console.log('⚠  Review each team\'s CAPACITY table before sharing (meridian capacity model gap).')
}

// The Insights content box is the empty text box directly below the "Insights"
// label (the template's retro scaffolding). Pick the empty box whose y is just
// under the label's y and shares its x column.
function findInsightsBox(slide: any): string {
  const els = (slide?.pageElements ?? []) as any[]
  const label = els.find((e) => (e.shape?.text?.textElements ?? []).map((t: any) => t.textRun?.content ?? '').join('').trim() === 'Insights')
  if (!label) throw new Error('Insights label not found on highlights slide')
  const ly = label.transform?.translateY ?? 0
  const candidates = els
    .filter((e) => e.shape && (e.shape.text?.textElements ?? []).map((t: any) => t.textRun?.content ?? '').join('').trim() === '')
    .filter((e) => (e.transform?.translateY ?? 0) > ly)
    .sort((a, b) => (a.transform?.translateY ?? 0) - (b.transform?.translateY ?? 0))
  if (!candidates.length) throw new Error('empty Insights box not found')
  return candidates[0].objectId
}

main().catch((e) => { console.error(e); process.exit(1) })
