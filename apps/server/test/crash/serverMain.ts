/**
 * The crash tests' child process (`serverChild.ts`): the app behind a port on `PAPERTIE_DATA`, the
 * fault of `PAPERTIE_FAULT` armed, a `listening` log line with the bound port, and a clean close on SIGTERM.
 */
import { loadConfig } from '../../src/config'
import { faultsFromEnv } from '../../src/store/faults'
import { startServer } from '../helpers/httpServer'

const dataDir = process.env.PAPERTIE_DATA
if (!dataDir) throw new Error('PAPERTIE_DATA is required')
const server = await startServer(loadConfig(dataDir), { faults: faultsFromEnv(process.env) })
server.deps.log.info('listening', { port: server.port })

let closing = false
process.on('SIGTERM', async () => {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
})
