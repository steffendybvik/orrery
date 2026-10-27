// The flags an untrusted schedule's session starts with (orrery-launcher.mjs). That session reads what people outside
// the project wrote (GitHub issues), which may try to steer it, so it can do little beyond reading them and raising
// proposals; Orrery holds its writes to that too (web/server/middleware/untrusted.ts).
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

/** How an untrusted schedule's session is started: it reads what others wrote (GitHub issues), so it gets Bash for
 * `gh issue list` and `gh issue view` only, and the channel's tools but `egress` and `secrets`; everything else is
 * refused, not asked (`dontAsk`, as nobody is there to answer). `--restricted` leaves out the user's and the repo's
 * settings (their allow lists among them), so the repo's hooks are passed back on their own, and only the repo's MCP
 * servers load. */
export function lockedDown(dir, server) {
    let hooks = {}
    try {
        hooks = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks ?? {}
    } catch {
        // No hooks: Orrery hears it only through its channel.
    }
    return ['--restricted', '--tools', 'Bash', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({hooks}),
        '--strict-mcp-config', '--mcp-config', join(dir, '.mcp.json'),
        '--allowedTools', 'Bash(gh issue list:*)', 'Bash(gh issue view:*)', `mcp__${server}`,
        '--disallowedTools', `mcp__${server}__egress`, `mcp__${server}__secrets`]
}
