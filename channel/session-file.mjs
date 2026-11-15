// Which Claude session a `claude` process is, for orrery's `/mcp` (ORR-1102): a session opened by hand gets `/mcp` from
// the install line's user-level entry, and Claude Code tells that entry's `headersHelper` neither the session id nor
// anything else about it. The channel knows its session, so it writes the headers its `/mcp` calls should carry to
// `~/.orrery/sessions/<claude pid>`; the helper (mcp-headers.mjs), started by the same `claude`, waits for that file
// and prints them.
import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

/** Where the files are kept. */
export const sessionsDir = (env = process.env, home = homedir()) => join(env.ORRERY_HOME ?? join(home, '.orrery'), 'sessions')

const fileFor = (pid, dir) => join(dir, String(pid))

/** Writes the `headers` for the `claude` at `pid`, in one go, readable only by this user. Returns how to take it away
 * again, which the channel does as it exits. */
export function writeSessionFile(pid, headers, dir = sessionsDir()) {
    if (!Number.isInteger(pid) || pid <= 1) return () => {}
    mkdirSync(dir, {recursive: true, mode: 0o700})
    const path = fileFor(pid, dir)
    const next = `${path}.${process.pid}.part`
    writeFileSync(next, JSON.stringify({pid, headers}), {mode: 0o600})
    renameSync(next, path)
    return () => {
        try {
            if (JSON.parse(readFileSync(path, 'utf8')).headers?.['Orrery-Session'] === headers['Orrery-Session']) unlinkSync(path)
        } catch {
            // Gone already.
        }
    }
}

/** The headers written for the `claude` at `pid`, if they were written since it started (`started`, ms): one left by an
 * earlier process with the same pid isn't its. */
export function readSessionFile(pid, {dir = sessionsDir(), started} = {}) {
    try {
        const path = fileFor(pid, dir)
        if (started && statSync(path).mtimeMs < started - 1000) return undefined
        const {headers} = JSON.parse(readFileSync(path, 'utf8'))
        return headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : undefined
    } catch {
        return undefined
    }
}

/** When the process `pid` started (ms), as `ps` has it; undefined if it can't tell. */
export function startedAt(pid) {
    try {
        const when = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {encoding: 'utf8'}).trim())
        return Number.isNaN(when) ? undefined : when
    } catch {
        return undefined
    }
}

/** Waits up to `within` ms for the file of the `claude` at `pid`, as the channel may still be starting. */
export async function waitForSessionFile(pid, {within = 5000, every = 100, dir, started = startedAt(pid)} = {}) {
    const until = Date.now() + within
    for (;;) {
        const headers = readSessionFile(pid, {dir, started})
        if (headers || Date.now() >= until) return headers
        await new Promise(resolve => setTimeout(resolve, every))
    }
}
