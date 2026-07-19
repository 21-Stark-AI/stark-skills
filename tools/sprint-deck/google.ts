// Thin Google Slides + Drive REST client. No googleapis dependency — we use
// fetch + an OAuth access token from the operator's gcloud ADC (the same path
// the deck was first built with). The token must carry Drive + Slides scope:
//   gcloud auth login --enable-gdrive-access
// and a quota project must be set (Slides requires X-Goog-User-Project on ADC).
import { execFileSync } from 'node:child_process'

const SLIDES = 'https://slides.googleapis.com/v1/presentations'
const DRIVE = 'https://www.googleapis.com/drive/v3/files'

export interface GoogleAuth {
  token: string
  quotaProject: string
}

/** Resolve an access token from gcloud ADC (or GOOGLE_ACCESS_TOKEN env). */
export function resolveAuth(quotaProject: string): GoogleAuth {
  const envToken = process.env.GOOGLE_ACCESS_TOKEN
  const token =
    envToken?.trim() ||
    execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim()
  if (!token) throw new Error('no access token (set GOOGLE_ACCESS_TOKEN or run gcloud auth login --enable-gdrive-access)')
  return { token, quotaProject }
}

function headers(auth: GoogleAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    'X-Goog-User-Project': auth.quotaProject,
    'Content-Type': 'application/json',
  }
}

/** Copy a presentation (Drive files.copy) and return the new file id. */
export async function copyPresentation(auth: GoogleAuth, templateId: string, name: string): Promise<string> {
  const res = await fetch(`${DRIVE}/${templateId}/copy`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`drive copy failed ${res.status}: ${await res.text()}`)
  const j = (await res.json()) as { id: string }
  return j.id
}

/** Run a batchUpdate; returns the raw replies array. */
export async function batchUpdate(auth: GoogleAuth, presentationId: string, requests: unknown[]): Promise<unknown[]> {
  const res = await fetch(`${SLIDES}/${presentationId}:batchUpdate`, {
    method: 'POST',
    headers: headers(auth),
    body: JSON.stringify({ requests }),
  })
  if (!res.ok) throw new Error(`slides batchUpdate failed ${res.status}: ${await res.text()}`)
  const j = (await res.json()) as { replies?: unknown[] }
  return j.replies ?? []
}

/** Fetch the presentation (used to discover duplicated element ids). */
export async function getPresentation(auth: GoogleAuth, presentationId: string, fields?: string): Promise<any> {
  const url = fields ? `${SLIDES}/${presentationId}?fields=${encodeURIComponent(fields)}` : `${SLIDES}/${presentationId}`
  const res = await fetch(url, { headers: headers(auth) })
  if (!res.ok) throw new Error(`slides get failed ${res.status}: ${await res.text()}`)
  return res.json()
}
