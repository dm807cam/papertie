/**
 * The page's one polite live region, for things said to a screen reader that nothing on screen
 * shows (an undo that skipped what a restore took off the board). Notices and the save dot speak
 * through their own regions, which hold what they show.
 */
let region: HTMLElement | null = null
/** A trailing no-break space, toggled, so the same words twice are still read twice. */
let toggled = false

function regionOf(doc: Document): HTMLElement {
  if (region?.isConnected && region.ownerDocument === doc) return region
  const el = doc.createElement('div')
  el.setAttribute('aria-live', 'polite')
  el.setAttribute('aria-atomic', 'true')
  el.dataset.liveRegion = ''
  // Read by screen readers only (as `.sync-live`), styled here so it needs no stylesheet. At the
  // page's top: left where the body ends, its pixel would make the page taller than the window.
  Object.assign(el.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  })
  doc.body.append(el)
  region = el
  return el
}

/** Say `text` politely; does nothing where there is no document. */
export function announce(text: string): void {
  if (typeof document === 'undefined') return
  toggled = !toggled
  regionOf(document).textContent = toggled ? text : `${text} `
}
