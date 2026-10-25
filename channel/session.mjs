// Which Claude window this process belongs to: Claude Code gives everything it starts the session id
// and its own pid; failing those, the nearest `claude` above this process.
import {execFileSync} from 'node:child_process'

export function claudeWindow() {
    const id = process.env.CLAUDE_CODE_SESSION_ID || undefined
    let pid = Number(process.env.CLAUDE_PID) || undefined
    if (!pid) {
        try {
            for (let at = process.ppid, hops = 0; at > 1 && hops < 8; hops++) {
                const [parent, ...name] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(at)], {encoding: 'utf8'}).trim().split(/\s+/)
                if (/(^|\/)claude$/.test(name.join(' '))) {
                    pid = at
                    break
                }
                at = Number(parent)
            }
        } catch {
            // No ps: the session id has to do.
        }
    }
    return {id, pid, name: process.env.ORRERY_SESSION || undefined}
}
