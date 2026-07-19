// The template-deck contract. These ids MUST match your template presentation:
// the two source slides (a KPI+Goals slide and a Sprint Highlights slide) and
// the element ids inside them. The generator duplicates these two slides per
// team and repopulates by id.
//
// To adapt to a new template: open the template deck, run
//   node --experimental-strip-types sprint-deck.ts --inspect <deckId>
// which prints every slide + element id so you can fill this in.
import type { TeamSlideIds } from './render.ts'

export interface TemplateConfig {
  /** The template presentation id to copy for each run. */
  templateDeckId: string
  /** Source slide id of the KPI + Goals template slide. */
  kpiSlideId: string
  /** Source slide id of the Sprint Highlights template slide. */
  hlSlideId: string
  /** Element ids inside the KPI slide. */
  kpi: { title: string; capTable: string; statTable: string; goalsBox: string }
  /** Element ids inside the Highlights slide. */
  hl: { title: string; cards: string[]; insightsBox: string }
}

// The Infra Scrumban deck built 2026-07-19. Replace with your own template's ids
// (via --inspect) if you fork the template.
export const INFRA_TEMPLATE: TemplateConfig = {
  templateDeckId: '1cDEfDwhHQKtWyfbj076OrOZNajwSQi4cENrobGR6OUA',
  kpiSlideId: 'kpislide1',
  hlSlideId: 'hlslide',
  kpi: { title: 'kpix_title', capTable: 'capx_tbl', statTable: 'stat2_tbl', goalsBox: 'g3f562aa6a5d_6_0' },
  hl: { title: 'hl_title', cards: ['hlcard0', 'hlcard1', 'hlcard2', 'hlcard3', 'hlcard4', 'hlcard5', 'hlcard6', 'hlcard7'], insightsBox: 'g3f562aa6a5d_8_3' },
}

// Per-team mapping to a meridian team UUID + the display title used on slides.
// Extend as teams are added. UUIDs are the meridian `public.teams.id`.
export const TEAMS: Record<string, { uuid: string; title: string }> = {
  cloud: { uuid: 'a1ee7664-2034-4739-ae04-952092c7a040', title: 'Cloud' },
  'manual-auditor': { uuid: '06d34fe5-4d9c-4975-a3c5-7d0e8fb83a2f', title: 'Manual Auditor' },
  'ai-devex': { uuid: '9c9abf9a-1bb7-4e6c-bed5-208805e21514', title: 'AI DevEx' },
  devops: { uuid: '583da2cf-9d81-436f-a187-031aec970d3a', title: 'DevOps' },
}

/** Build the per-team duplicated-slide id set from a prefix. */
export function teamSlideIds(prefix: string): TeamSlideIds {
  return {
    kpiTitle: `${prefix}_kpi_title`,
    capTable: `${prefix}_cap`,
    statTable: `${prefix}_stat`,
    goalsBox: `${prefix}_goals`,
    hlTitle: `${prefix}_hl_title`,
    cards: Array.from({ length: 8 }, (_, i) => `${prefix}_c${i}`),
    insightsBox: '', // resolved after duplication (discovered by position)
  }
}
