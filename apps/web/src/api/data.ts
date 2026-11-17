import { apiJson } from './http'

/** The word "Delete all data" asks to be typed (the server compares it trimmed, in any case). */
export const DELETE_ALL_WORD = 'delete'

/**
 * "Delete all data": every board, photo, book and backup goes, and one empty board is left.
 * `confirm` is what was typed ({@link DELETE_ALL_WORD}).
 */
export async function deleteAllData(confirm: string): Promise<void> {
  await apiJson('/api/data/delete', { method: 'POST', json: { confirm } })
}
