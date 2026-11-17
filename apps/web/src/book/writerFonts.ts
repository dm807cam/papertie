// The writer's italics (Instrument Sans italic, 400 and 600), loaded with the writer's chunk
// and imported by `BookScreen` alone: the board's first paint never waits on them, and nothing
// for the writer is in `styles/fonts.ts`. Self-hosted, as every face is.
import '@fontsource/instrument-sans/400-italic.css'
import '@fontsource/instrument-sans/600-italic.css'
