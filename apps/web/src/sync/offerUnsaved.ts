/**
 * The unsaved-changes download as every button offers it: the ops' JSONL, and when book edits
 * are among them, their text as a second `.md` file, made by the book chunk
 * (`book/bookSync.ts`, `unsavedFile`), loaded here when it is needed. A JSONL without book ops
 * downloads at once, as it always did.
 */
import type { BoardState, ClientOp } from '@papertie/core'
import { hasBlockOps, loadBookSync } from './books/bookOps'
import { downloadUnsaved } from './unsavedDownload'

/** What the text is made of (`SyncClient.unsavedParts`): the view, the pending, the dropped. */
export interface UnsavedParts {
  view: BoardState | null
  pending: readonly ClientOp[][]
  dropped: readonly ClientOp[][]
}

/**
 * Download `jsonl`, and the `.md` of its book edits. `parts`: what this page holds (the text as
 * the view has it); without (a session with no client), the JSONL alone, whose
 * book edits are given by what they typed.
 */
export async function offerUnsaved(jsonl: string, parts?: UnsavedParts): Promise<void> {
  const books = parts
    ? [...parts.pending, ...parts.dropped].some((ops) => hasBlockOps(ops))
    : jsonl.includes('"block.')
  let md = ''
  if (books)
    md = await loadBookSync().then(
      (rx) => rx.unsavedFile(jsonl, parts),
      () => '',
    )
  if (md === '') downloadUnsaved(jsonl)
  else downloadUnsaved(jsonl, new Date(), md)
}
