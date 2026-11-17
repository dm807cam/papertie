/**
 * zod's JSON Schema generator (`to-json-schema.js`, `json-schema-processors.js`), as the
 * production build of the page and of its workers has it (`vite.config.ts`, `zodWithoutJsonSchema`,
 * in `plugins` and `worker.plugins`; the dev server and the tests keep the real one): nothing in
 * the app makes JSON Schema of its schemas (core's `gen:schema` does, in Node, with the real one),
 * so the some 6 KB of it (gzip) every zod schema carries stay out of the initial JS
 * and the parse worker. Each schema still gets its methods; calling one throws.
 */
const none = (): never => {
  throw new Error('JSON Schema is not made in the browser')
}

// to-json-schema.js
export const createToJSONSchemaMethod = () => none
export const createStandardJSONSchemaMethod = () => none
export const initializeContext = none
export const handleUnrepresentable = none
export const processSchema = none
export const process = none
export const extractDefs = none
export const finalize = none

// json-schema-processors.js (a schema's checks, as JSON Schema reads them: none here)
export const aggregateChecks = () => ({})
export const allProcessors = {}
export const toJSONSchema = none
export const stringProcessor = none
export const numberProcessor = none
export const booleanProcessor = none
export const bigintProcessor = none
export const symbolProcessor = none
export const nullProcessor = none
export const undefinedProcessor = none
export const voidProcessor = none
export const neverProcessor = none
export const anyProcessor = none
export const unknownProcessor = none
export const dateProcessor = none
export const enumProcessor = none
export const literalProcessor = none
export const nanProcessor = none
export const templateLiteralProcessor = none
export const fileProcessor = none
export const successProcessor = none
export const customProcessor = none
export const functionProcessor = none
export const transformProcessor = none
export const mapProcessor = none
export const setProcessor = none
export const arrayProcessor = none
export const objectProcessor = none
export const unionProcessor = none
export const intersectionProcessor = none
export const tupleProcessor = none
export const recordProcessor = none
export const nullableProcessor = none
export const nonoptionalProcessor = none
export const defaultProcessor = none
export const prefaultProcessor = none
export const catchProcessor = none
export const pipeProcessor = none
export const readonlyProcessor = none
export const promiseProcessor = none
export const optionalProcessor = none
export const lazyProcessor = none
export const allProcessor = none
