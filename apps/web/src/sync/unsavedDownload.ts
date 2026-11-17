/** `2026-10-30`: the local date, for a file name. */
const day = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function save(text: string, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // The browser has the file once the click is handled; the URL can go a turn later.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Hand the user `jsonl` (`SyncClient.unsavedJsonl()`: one `{"op":…}` per line) as a file,
 * `papertie-unsaved-<date>.jsonl`, and with it, when the unsaved batches touch a book, `md`
 * (`SyncClient.unsavedText()`: the paragraphs' text under their books' titles) as a second plain
 * file named like it, `papertie-unsaved-<date>.md`. Nothing leaves the computer.
 */
export function downloadUnsaved(jsonl: string, now: Date = new Date(), md = ''): void {
  save(jsonl, 'application/x-ndjson', `papertie-unsaved-${day(now)}.jsonl`)
  if (md !== '') save(md, 'text/markdown', `papertie-unsaved-${day(now)}.md`)
}
