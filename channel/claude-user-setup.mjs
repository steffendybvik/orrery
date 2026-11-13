// What the install line sets up in Claude Code's own config, for every folder on the machine (ORR-1067), so a Claude
// session reaches orrery before any project or repo is connected: a user-level MCP server per orrery (orrery's channel,
// serving every project), orrery's hooks at user level, and the orrery's default folder trusted, so the launcher can
// start sessions there. Particular to Claude Code, so the Claude adapter does it (claude-agent.mjs).
//
// Each piece carries ORRERY_SCOPE=user, so `--uninstall` finds what it put there and nothing else. A repo's own server
// of the same name takes precedence over the user-level one, so connected repos keep theirs. Claude Code runs user and
// project hooks both, though, so the user-level hook stands down where the folder has orrery's hook of its own
// (orrery-hook.mjs, `standsDown`).
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {ASYNC_EVENTS, HOOK_EVENTS} from './claude-hooks.mjs'
import {serverName} from './server-name.mjs'
import {besideName} from './mcp-beside.mjs'

export const SCOPE = 'ORRERY_SCOPE=user'
const ORRERY_ID = /^[A-Za-z0-9_-]{1,100}$/
const SHELL_SAFE = /^[\w@%+=:,./~-]+$/

/** Claude Code's user settings and its own state file (where user-level servers and folder trust live). */
export function claudeFiles(home = homedir(), env = process.env) {
    const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    return {settings: join(config, 'settings.json'), state: env.CLAUDE_CONFIG_DIR ? join(config, '.claude.json') : join(home, '.claude.json')}
}

function check({url, orrery}) {
    if (!ORRERY_ID.test(orrery?.id ?? '')) throw new Error("orrery sent an id that this launcher won't write into a file")
    if (!SHELL_SAFE.test(url ?? '')) throw new Error(`${url} can't go into a hook's command`)
}

/** The user-level server for the orrery at `url`: its name and the JSON `claude mcp add-json` takes. Beside its `/mcp`
 * (`mcp`, ORR-1102) it lists only its own tools (`ORRERY_TOOLS=local`), as a session the launcher starts there does. */
export function userServer({url, orrery, commands, mcp = false}) {
    check({url, orrery})
    return {
        name: serverName(orrery.environment),
        config: {type: 'stdio', ...commands.channel, env: {ORRERY_URL: url, ORRERY_ID: orrery.id, ORRERY_PROJECTS: '*', ORRERY_SCOPE: 'user', ...mcp ? {ORRERY_TOOLS: 'local'} : {}}},
    }
}

/** The user-level entry for the orrery's own `/mcp` (ORR-1102), beside the channel and named as the launcher names it
 * (mcp-beside.mjs): Claude Code tells its `headersHelper` nothing of the session, so the helper reads the headers the
 * session's channel wrote (session-file.mjs, mcp-headers.mjs). */
export function userMcpServer({url, orrery, commands}) {
    check({url, orrery})
    return {
        name: besideName(serverName(orrery.environment)),
        config: {type: 'http', url: `${url}/mcp`, headersHelper: `${SCOPE} ORRERY_URL=${url} ORRERY_ID=${orrery.id} ${commands.headers}`},
    }
}

/** The user-level hook command for the orrery at `url`. */
export const userHook = ({url, orrery, commands}) => `${SCOPE} ORRERY_URL=${url} ORRERY_ID=${orrery.id} ${commands.hook}`

const ours = (command, id) => typeof command === 'string' && command.startsWith(`${SCOPE} `) && (id === undefined || command.includes(` ORRERY_ID=${id} `))

/** `settings` without the user-level hooks this install put there (for orrery `id`, or every orrery's), keeping all else. */
export function withoutUserHooks(settings, id) {
    const hooks = {}
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
        const kept = (Array.isArray(groups) ? groups : []).map(group => ({...group, hooks: (group.hooks ?? []).filter(hook => !ours(hook.command, id))}))
            .filter(group => group.hooks.length)
        if (kept.length) hooks[event] = kept
    }
    const {hooks: _, ...rest} = settings
    return Object.keys(hooks).length ? {...rest, hooks} : rest
}

/** `settings` with orrery's hooks for the orrery at `url` on every event, once, beside whatever else is there. */
export function withUserHooks(settings, {url, orrery, commands}) {
    check({url, orrery})
    const command = userHook({url, orrery, commands})
    const kept = withoutUserHooks(settings, orrery.id)
    const hooks = {...kept.hooks}
    for (const event of HOOK_EVENTS) {
        hooks[event] = [...hooks[event] ?? [], {hooks: [{type: 'command', command, timeout: 5, ...ASYNC_EVENTS.includes(event) ? {async: true} : {}}]}]
    }
    return {...kept, hooks}
}

/** Claude Code's state with the folder `dir` trusted (or no longer, `trusted` false, but only if this install trusted it). */
export function withTrust(state, dir, trusted = true) {
    const projects = {...state.projects}
    const was = projects[dir] ?? {}
    if (trusted) projects[dir] = {...was, hasTrustDialogAccepted: true, orreryTrusted: true}
    else if (was.orreryTrusted) {
        const {orreryTrusted: _, ...rest} = was
        projects[dir] = {...rest, hasTrustDialogAccepted: false}
    }
    return {...state, projects}
}

/** The user-level servers this install added, by name, from Claude Code's state. */
export function userServers(state) {
    return Object.entries(state.mcpServers ?? {}).filter(([, server]) => server?.env?.ORRERY_SCOPE === 'user').map(([name, server]) => ({name, id: server.env.ORRERY_ID}))
}

/** The user-level `/mcp` entries this install added, by name: their helper is marked as its hooks are. */
export const userMcpServers = state => Object.entries(state.mcpServers ?? {}).filter(([, server]) => ours(server?.headersHelper)).map(([name]) => name)

function readJson(path) {
    if (!existsSync(path)) return {}
    let value
    try {
        value = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`${path} isn't valid JSON (${error.message}): fix it and try again`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} isn't a JSON object: fix it and try again`)
    return value
}

/** Writes in one go, by a rename, so a Claude reading it at the same moment gets the old file or the new one. */
function writeJson(path, value) {
    mkdirSync(dirname(path), {recursive: true})
    const next = `${path}.${process.pid}.part`
    writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600})
    renameSync(next, path)
}

/** Sets the machine up for the orrery at `url`: the server through `claude mcp` (`run`: runs it, as separate words), and
 * its `/mcp` beside it when the orrery serves that (`mcp`), then the hooks and the default folder's trust. Safe to run
 * again. */
export function setUpUser({url, orrery, commands, home: dir, run, mcp = false, files = claudeFiles()}) {
    const servers = [userServer({url, orrery, commands, mcp}), ...mcp ? [userMcpServer({url, orrery, commands})] : []]
    for (const name of [serverName(orrery.environment), besideName(serverName(orrery.environment))]) {
        try {
            run(['mcp', 'remove', '--scope', 'user', name])
        } catch {
            // There was none yet.
        }
    }
    for (const {name, config} of servers) run(['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(config)])
    const {name} = servers[0]
    writeJson(files.settings, withUserHooks(readJson(files.settings), {url, orrery, commands}))
    // After `claude mcp`, which writes the same file.
    if (dir) writeJson(files.state, withTrust(readJson(files.state), dir))
    return {server: name, settings: files.settings}
}

/** Takes out what `setUpUser` put in, for every orrery: the servers it added, its hooks and the trust it gave
 * (`homeOf`: an orrery id's default folder). Returns the servers' names. */
export function undoUser({run, homeOf, files = claudeFiles()}) {
    const before = readJson(files.state)
    const servers = userServers(before)
    for (const name of [...servers.map(server => server.name), ...userMcpServers(before)]) {
        try {
            run(['mcp', 'remove', '--scope', 'user', name])
        } catch {
            // Gone already.
        }
    }
    if (existsSync(files.settings)) writeJson(files.settings, withoutUserHooks(readJson(files.settings)))
    let state = readJson(files.state)
    for (const {id} of servers) {
        if (ORRERY_ID.test(id ?? '')) state = withTrust(state, homeOf(id), false)
    }
    if (servers.length) writeJson(files.state, state)
    return servers.map(server => server.name)
}

/** Whether the user-level hook should say nothing for this session (ORR-1067): it isn't the user-level one, it is but
 * the folder has orrery's hook of its own (which Claude Code runs as well), no project is known for it (`project`, as
 * the hook found it: ORRERY_PROJECT, or the launcher's list mapping the folder, ORR-1068), or another orrery started it
 * (ORRERY_STARTED_ON, the starting orrery's id, against this hook's ORRERY_ID, ORR-1071): each orrery set up on the
 * machine has a hook of its own, and every one runs in every session. */
export function standsDown({env = process.env, dir, project = env.ORRERY_PROJECT}) {
    if (env.ORRERY_SCOPE !== 'user') return false
    if (!project) return true
    if (env.ORRERY_STARTED_ON && env.ORRERY_STARTED_ON !== env.ORRERY_ID) return true
    for (const name of ['settings.json', 'settings.local.json']) {
        try {
            const text = readFileSync(join(dir, '.claude', name), 'utf8')
            if (/orrery-hook\.mjs|bootstrap\.mjs[\\"]* hook/.test(text)) return true
        } catch {
            // No such file.
        }
    }
    return false
}
