import { createContext } from 'react'
import { PendingImages } from './pending'

/** What a note's photo needs from its board: the photos on their way, and the file picker. */
export interface PhotoActions {
  pending: PendingImages
  /** Open the file picker to put a photo on this note. */
  pick?(noteId: string): void
}

/** An empty board's photos, for a note drawn outside a canvas (the study page, tests). */
export const PhotoContext = createContext<PhotoActions>({ pending: new PendingImages() })
