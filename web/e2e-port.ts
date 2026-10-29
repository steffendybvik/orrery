// The port a checkout's browser tests serve on (ORR-505): the same for one checkout every time, as Playwright reads its
// config again in each worker, and most likely another for each other checkout (a worktree per session), so runs side by
// side don't share a server and its database. `base` starts the range, 200 wide: clear of 3000–3070, which other
// work holds, and of 33xx, where dev servers go. E2E_PORT picks one outright.
import {createHash} from 'node:crypto'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

export function e2ePort(base: number): number {
    if (process.env.E2E_PORT) return Number(process.env.E2E_PORT)
    const checkout = dirname(fileURLToPath(import.meta.url))
    return base + createHash('sha256').update(checkout).digest().readUInt16BE(0) % 200
}
