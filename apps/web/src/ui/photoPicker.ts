/**
 * The one place "add a photo" starts: the sidebar's Photo button, the mini-bar's and the P key
 * all call `openPhotoPicker`. The image drop registers the function that opens the file picker
 * and places the photo notes at the view's centre; until one is registered the call does nothing.
 */
let opener: (() => void) | null = null

/** Register the function that opens the picker; the returned function takes it back. */
export function registerPhotoPicker(open: () => void): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/** Open the photo file picker, when an image drop has registered one. */
export function openPhotoPicker(): void {
  opener?.()
}
