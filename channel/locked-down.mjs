// The flags an untrusted schedule's session starts with (orrery-launcher.mjs). That session reads what people outside
// the project wrote (GitHub issues), which may try to steer it, so it can do little beyond reading them and raising
// proposals; orrery holds its writes to that too (web/server/middleware/untrusted.ts). And those the owner's chat
// starts with: the owner's own settings, less the channel tools orrery keeps from it (web/server/middleware/chat.ts).
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {NOT_FOR_CHAT, NOT_FOR_UNTRUSTED} from './tools.mjs'

/** How an untrusted schedule's session is started: it reads what others wrote (GitHub issues) with the channel's
 * `github_issues`, and has no Bash, nor any other of Claude Code's own tools, so it can't point gh at another host and
 * send what it read there (ORR-415). It has the channel's tools but `NOT_FOR_UNTRUSTED` (tools.mjs) and `more_tools`; everything else is
 * refused, not asked (`dontAsk`, as nobody is there to answer). `--restricted` leaves out the user's and the repo's
 * settings (their allow lists among them), so the repo's hooks are passed back on their own. Its one MCP server is
 * orrery's channel, which the launcher hands it itself (ORR-1066): not the repo's .mcp.json, whose other servers would
 * give it tools beyond orrery's. With orrery's `/mcp` beside it (`beside`, ORR-1102), that too: `/mcp` lists it only
 * the untrusted session's tools, and its rails hold their writes as the server's guard does. */
export function lockedDown(dir, server, beside) {
    const servers = {...channelOnly(dir, server).mcpServers, ...beside?.config.mcpServers}
    return ['--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--settings', JSON.stringify({hooks: hooksOf(dir)}),
        ...beside?.fresh ? ['--session-id', beside.session] : [],
        '--strict-mcp-config', '--mcp-config', JSON.stringify({mcpServers: servers}),
        '--allowedTools', `mcp__${server}`, ...beside ? [`mcp__${beside.name}`] : [],
        '--disallowedTools', ...[...NOT_FOR_UNTRUSTED, 'more_tools'].map(tool => `mcp__${server}__${tool}`)]
}

/** How the owner's chat session is started: with the Claude Code settings of the machine it runs on, as a terminal there
 * (ORR-750), so what they allow it may do, what they deny it may not, and what they'd ask about it asks. orrery holds it
 * only to its own rules: the channel but its tools that take up work (its GitHub reads among what it keeps, ORR-748). */
export function chatOnly(dir, server, beside) {
    return ['--allowedTools', `mcp__${server}`,
        '--disallowedTools', ...NOT_FOR_CHAT.map(tool => `mcp__${server}__${tool}`), ...besideArgs(beside)]
}

/** orrery's `/mcp` beside a session's channel (`beside`, from mcp-beside.mjs, ORR-1102): its entry, its tools
 * allowed (`/mcp` lists the chat only the chat's), and the Claude session id it's for, when it's a new one. */
export function besideArgs(beside) {
    if (!beside) return []
    return [...beside.fresh ? ['--session-id', beside.session] : [], '--mcp-config', JSON.stringify(beside.config), '--allowedTools', `mcp__${beside.name}`]
}

/** The MCP config an untrusted session loads: only the folder's `server`, orrery's channel, as its .mcp.json has it;
 * no server at all when it has none by that name. */
function channelOnly(dir, server) {
    const entry = settingsIn(join(dir, '.mcp.json')).mcpServers?.[server]
    return {mcpServers: entry ? {[server]: entry} : {}}
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

/** What starts a launch's session on the model and effort orrery asked for (ORR-868); none, on Claude Code's own default.
 * Only a model or effort of the shape orrery sends is passed on, as separate words to tmux, never through a shell. */
/** `--resume <id>` for a chat taken up again on its Claude session (ORR-884), when the launch asks for one that's a
 * Claude Code session id; nothing otherwise. */
export function resumeArgs(launch) {
    return launch.chat && typeof launch.resume === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(launch.resume) ? ['--resume', launch.resume] : []
}

export function modelArgs(launch) {
    const model = typeof launch.model === 'string' && /^[a-z][a-z0-9.\-]*(\[1m\])?$/.test(launch.model) && launch.model.length <= 64 ? launch.model : ''
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(launch.effort) ? launch.effort : ''
    return [...model ? ['--model', model] : [], ...effort ? ['--effort', effort] : []]
}
