/**
 * The lazy chunks a board loads at idle once it is up, loaded before each test file: a test
 * opens them as a user does after the board has settled (in the commit that opens them).
 * `test/cold/` covers opening one before it is in.
 */
import { PickerChunk } from '../../src/search/LazyPicker'

await PickerChunk.load()
