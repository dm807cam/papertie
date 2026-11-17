import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/**
 * The note the `Connect to…` picker is open for, or null. Opened by C on a selected note
 * (`installCaptureHandlers`) and followed by `YarnLayer`, which draws the picker on the board.
 */
const connectStore = createStore<{ from: string | null }>(() => ({ from: null }))

export const openConnect = (noteId: string): void => connectStore.setState({ from: noteId })
export const closeConnect = (): void => connectStore.setState({ from: null })
export const connectFrom = (): string | null => connectStore.getState().from

export function useConnectFrom(): string | null {
  return useStore(connectStore, (s) => s.from)
}
