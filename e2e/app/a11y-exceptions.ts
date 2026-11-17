import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

/**
 * The accessibility pass's one axe configuration: WCAG 2.0 A and AA, WCAG 2.1
 * AA and axe's best practices, every impact counted. The specs read violations through
 * {@link axeViolations}, which leaves out only what is listed in {@link A11Y_EXCEPTIONS}.
 */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] as const

/**
 * What axe is not asked to judge, and why. An exception is allowed only for content drawn on a
 * canvas that has a DOM equivalent the keyboard and a screen reader reach.
 *
 * - The board's canvases (`canvas.yarn-layer`, `canvas.pin-layer`): the yarn, the pins and, at
 *   far zoom, the overview's note cards. The yarn is drawn there and nowhere in the DOM, and it
 *   has no visible list of its own. Its DOM equivalent is threefold:
 *   1. Each mounted note's accessible description names the notes it is tied to, by thread
 *      colour, in English (`Tied to "Spring trip" and "Packing list" by indigo yarn.`). It is
 *      read from the note's own threads (the thread index kept with the yarn map), for the
 *      mounted notes only, never for the whole board (`apps/web/src/yarn/tiedTo.ts`).
 *   2. The page's live region says every tie, wind, untie and failure as it happens
 *      (`Tied "A" to "B" with indigo yarn`).
 *   3. *Connect to…* (C) ties the selected note to any other from a searchable list, with no
 *      pointer; Delete on a selected thread unties it.
 *   At far zoom (the overview, below 15 %) the notes are cards on the canvas, not in the DOM:
 *   ⌘K finds any note and takes the camera to it, and the arrow keys still move the selection.
 *
 * axe reads no pixels of a canvas, so these entries exclude nothing it would otherwise flag;
 * they are written down so the reason stays next to the rule.
 */
export const A11Y_EXCEPTIONS: readonly { selector: string; why: string }[] = [
  {
    selector: 'main.viewport > canvas',
    why:
      'Canvas-drawn yarn, pins and far-zoom cards: yarn is reached through each note’s ' +
      '“Tied to … by … yarn” description, the live region and Connect to… (C); far-zoom ' +
      'cards through ⌘K and the arrow keys.',
  },
]

/**
 * An axe run on `page` with the pass's tags and its exceptions. In the page itself (axe's legacy
 * mode): the app has one window and opens no other.
 */
export function axeFor(page: Page): AxeBuilder {
  let b = new AxeBuilder({ page }).withTags([...AXE_TAGS]).setLegacyMode()
  for (const e of A11Y_EXCEPTIONS) b = b.exclude(e.selector)
  return b
}

/** Every violation on the page as it is now, of any impact, in a form that reads in a diff. */
export async function axeViolations(page: Page) {
  const { violations } = await axeFor(page).analyze()
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1] ?? ''}`),
  }))
}
