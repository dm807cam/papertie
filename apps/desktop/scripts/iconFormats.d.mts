/** The types of `iconFormats.mjs`. */
export function icns(pngBySize: Map<number, Buffer>): Buffer
export function ico(images: ReadonlyArray<{ size: number; data: Buffer }>): Buffer
export function dib(rgba: Uint8Array, size: number): Buffer
