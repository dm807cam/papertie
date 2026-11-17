/** Whether the main pointer is a finger (`pointer: coarse`): copy says Tap there, not Press. */
export const touchScreen = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
