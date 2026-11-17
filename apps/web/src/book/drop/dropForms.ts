/**
 * The form a card dropped into a book lands in at once: the one chosen most,
 * counted in the app's storage. Paragraph when none is counted, on a tie, or when the
 * storage cannot be read (blocked, full, written by something else); counting never throws.
 */
import type { DropForm } from './cardBlocks'

export const DROP_FORMS_KEY = 'papertie.dropForms'

const FORMS: readonly DropForm[] = ['p', 'quote', 'prompt']

/** The counts kept, each a whole number ≥ 0; anything else in storage is left out. */
function counts(): Partial<Record<DropForm, number>> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DROP_FORMS_KEY) ?? '{}')
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Partial<Record<DropForm, number>> = {}
    for (const f of FORMS) {
      const n = (v as Record<string, unknown>)[f]
      if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) out[f] = n
    }
    return out
  } catch {
    return {}
  }
}

/** The form chosen most; ties and none → 'p'. */
export function likelyForm(): DropForm {
  const c = counts()
  let best: DropForm = 'p'
  let most = 0
  let tied = false
  for (const f of FORMS) {
    const n = c[f] ?? 0
    if (n > most) {
      best = f
      most = n
      tied = false
    } else if (n === most && n > 0) tied = true
  }
  return tied ? 'p' : best
}

/** Counted when the user picks a form (a switch, or keeping the default by typing on). */
export function chosen(form: DropForm): void {
  try {
    const c = counts()
    c[form] = (c[form] ?? 0) + 1
    localStorage.setItem(DROP_FORMS_KEY, JSON.stringify(c))
  } catch {
    // Unusable storage: the likely form stays Paragraph.
  }
}
