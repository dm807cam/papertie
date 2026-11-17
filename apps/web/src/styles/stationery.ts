/** The pins' mid brass: lite and overview pin dots, the dome's washer and hook, the hint's pin. */
export const PIN_BRASS = '#B08A3A'

/** A print's white stock: its border and caption band, and the selection's light halo. */
export const PRINT_STOCK = '#FBF8F2'

/** The stationery colours as CSS custom properties, installed on `:root` with the palette's. */
export const STATIONERY_CSS_VARS = {
  '--pin-brass': PIN_BRASS,
  '--print-stock': PRINT_STOCK,
} as const
