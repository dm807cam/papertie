/**
 * The board schema version this build reads and writes. A file of any other version is refused
 * whole (`unsupported-version`): nothing is converted.
 *
 * Raise it with any change to the values a record may hold: one that makes a value valid under
 * this version invalid (a tightened limit, an enum value removed), and any value added to an enum
 * or a union (a mark's `t`, a block kind). The store loads a `board.jsonl` its eof checksum
 * vouches for without checking each record against the schema, only its keys (`BoardParser`'s
 * `deferRecords`), and the keys guard does not see values. A key removed needs no raise: the
 * guard sends a record carrying it to the schema check, which refuses it (`invalid-record`).
 */
export const CURRENT_SCHEMA_VERSION = 6
