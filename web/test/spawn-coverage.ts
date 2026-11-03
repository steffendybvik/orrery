// What a test gives a process it spawns, so its coverage is counted (ORR-745): with ORRERY_SPAWN_COVERAGE (a folder), V8 writes
// there as the process exits, read by scripts/coverage-lines.mjs. The tests set these themselves, as they start each process
// with an environment of its own. NODE_V8_COVERAGE on the run as a whole would catch Vitest's workers too.
import {fileURLToPath} from 'node:url'

const FLUSH = fileURLToPath(new URL('./flush-coverage.mjs', import.meta.url))

export const collecting = !!process.env.ORRERY_SPAWN_COVERAGE

export const spawnCoverage = (): Record<string, string> => collecting
    ? {NODE_V8_COVERAGE: process.env.ORRERY_SPAWN_COVERAGE!, NODE_OPTIONS: `--import=${FLUSH}`}
    : {}

/** How a test ends a spawned process: at once, or while collecting, so that it writes what it reached. */
export const endSignal = (): NodeJS.Signals => collecting ? 'SIGTERM' : 'SIGKILL'
