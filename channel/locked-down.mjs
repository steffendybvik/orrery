// The flags an untrusted schedule's session starts with (orrery-launcher.mjs). That session reads what people outside
// the project wrote (GitHub issues), which may try to steer it, so it can do little beyond reading them and raising
// proposals; Orrery holds its writes to that too (web/server/middleware/untrusted.ts). And those the owner's chat
// starts with: it reads the repo and the roadmap and answers, making issues and comments when asked
// (web/server/middleware/chat.ts).
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {NOT_FOR_CHAT} from './tools.mjs'

/** How an untrusted schedule's session is started: it reads what others wrote (GitHub issues), so it gets Bash for
 * `gh issue list` and `gh issue view` only, and the channel's tools but `egress` and `secrets`; everything else is
 * refused, not asked (`dontAsk`, as nobody is there to answer). `--restricted` leaves out the user's and the repo's
 * settings (their allow lists among them), so the repo's hooks are passed back on their own, and only the repo's MCP
 * servers load. */
export function lockedDown(dir, server) {
    return ['--restricted', '--tools', 'Bash', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({hooks: hooksOf(dir)}),
        '--strict-mcp-config', '--mcp-config', join(dir, '.mcp.json'),
        '--allowedTools', 'Bash(gh issue list:*)', 'Bash(gh issue view:*)', `mcp__${server}`,
        '--disallowedTools', `mcp__${server}__egress`, `mcp__${server}__secrets`]
}

/** How the owner's chat session is started: it reads the repo (`Read`, `Grep`, `Glob`, no Bash or edits) and the
 * roadmap, and has the channel's tools but `NOT_FOR_CHAT` (tools.mjs); everything else is refused, not asked. `--restricted` as
 * for `lockedDown`. */
export function chatOnly(dir, server) {
    return ['--restricted', '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({hooks: hooksOf(dir)}),
        '--strict-mcp-config', '--mcp-config', join(dir, '.mcp.json'),
        '--allowedTools', 'Read', 'Grep', 'Glob', `mcp__${server}`,
        '--disallowedTools', ...NOT_FOR_CHAT.map(tool => `mcp__${server}__${tool}`)]
}

/** The repo's hooks, passed back on their own, as `--restricted` leaves out its settings. */
function hooksOf(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).hooks ?? {}
    } catch {
        // No hooks: Orrery hears it only through its channel.
        return {}
    }
}
