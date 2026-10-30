// The flags an untrusted schedule's session starts with (orrery-launcher.mjs). That session reads what people outside
// the project wrote (GitHub issues), which may try to steer it, so it can do little beyond reading them and raising
// proposals; orrery holds its writes to that too (web/server/middleware/untrusted.ts). And those the owner's chat
// starts with: it reads the repo and the roadmap and answers, making issues and comments when asked
// (web/server/middleware/chat.ts).
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {NOT_FOR_CHAT, NOT_FOR_UNTRUSTED} from './tools.mjs'

/** How an untrusted schedule's session is started: it reads what others wrote (GitHub issues) with the channel's
 * `github_issues`, and has no Bash, nor any other of Claude Code's own tools, so it can't point gh at another host and
 * send what it read there (ORR-415). It has the channel's tools but `NOT_FOR_UNTRUSTED` (tools.mjs) and `more_tools`; everything else is
 * refused, not asked (`dontAsk`, as nobody is there to answer). `--restricted` leaves out the user's and the repo's
 * settings (their allow lists among them), so the repo's hooks are passed back on their own, and only the repo's MCP
 * servers load. */
export function lockedDown(dir, server) {
    return ['--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({hooks: hooksOf(dir)}),
        '--strict-mcp-config', '--mcp-config', join(dir, '.mcp.json'),
        '--allowedTools', `mcp__${server}`,
        '--disallowedTools', ...[...NOT_FOR_UNTRUSTED, 'more_tools'].map(tool => `mcp__${server}__${tool}`)]
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

/** The repo's hooks, passed back on their own, as `--restricted` leaves out its settings: `settings.json`'s and
 * `settings.local.json`'s, where a repo can keep them out of git. Without them orrery hears it only through its channel,
 * and never hears a turn end (ORR-744). */
function hooksOf(dir) {
    const hooks = {}
    for (const file of ['settings.json', 'settings.local.json']) {
        for (const [event, groups] of Object.entries(settingsIn(join(dir, '.claude', file)).hooks ?? {})) {
            hooks[event] = [...hooks[event] ?? [], ...groups]
        }
    }
    return hooks
}

function settingsIn(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return {}
    }
}
