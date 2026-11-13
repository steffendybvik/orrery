// orrery's default folder on this machine (ORR-1066): where the launcher service starts sessions, the chat among them,
// for an orrery's projects that have no repo, so a project needn't have one to get help or work done. One per orrery,
// `~/.orrery/<orrery id>/home`, which the launcher sets up itself: the channel in its .mcp.json (serving every project,
// the launch saying which it hears), orrery's hooks in .claude/settings.json (with no project fixed, as the launch's
// ORRERY_PROJECT says it), and a CLAUDE.md saying there's no repo here. orrery never names the folder: the launcher
// makes it from the orrery's id, and tells orrery nothing of where it is.
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {ASYNC_EVENTS, HOOK_EVENTS} from './claude-hooks.mjs'
import {serverName} from './server-name.mjs'

const ORRERY_ID = /^[A-Za-z0-9_-]{1,100}$/
/** An address or path that goes into a hook's command, which a shell runs: nothing a shell would read as more. */
const SHELL_SAFE = /^[\w@%+=:,./~-]+$/
const PATH_SAFE = /^[^"$`\\\n]+$/

/** The default folder for the orrery with this id, under `home`. */
export function homeFolder(id, home = homedir()) {
    if (!ORRERY_ID.test(id ?? '')) throw new Error("orrery sent an id that this launcher won't make a folder of")
    return join(home, '.orrery', id, 'home')
}

/** What the folder's channel and hooks run: the bootstrap, when that's what runs the launcher, else this checkout's own. */
export function commandsFor({bootstrap, checkout}) {
    const path = bootstrap ?? checkout
    if (!PATH_SAFE.test(path ?? '')) throw new Error(`the launcher runs from ${path}, which can't go into a hook's command`)
    return bootstrap
        ? {channel: {command: 'node', args: [bootstrap, 'channel']}, hook: `node "${bootstrap}" hook`, headers: `node "${bootstrap}" headers`}
        : {channel: {command: 'node', args: [join(checkout, 'orrery-channel.mjs')]}, hook: `node "${join(checkout, 'orrery-hook.mjs')}"`, headers: `node "${join(checkout, 'mcp-headers.mjs')}"`}
}

export const HOME_CLAUDE_MD = `# orrery's default folder

This folder isn't a repo. orrery's launcher starts sessions here for the projects that have no repo, so there's no
code to read or change here, and no git: don't look for one. Work through orrery's tools, on the project the session
was started for.
`

/** The folder's files for the orrery at `url` (`orrery`: {id, environment}): `{server, files}`, by name within it. */
export function homeFiles({url, orrery, commands}) {
    if (!ORRERY_ID.test(orrery?.id ?? '')) throw new Error("orrery sent an id that this launcher won't write into a file")
    if (!SHELL_SAFE.test(url ?? '')) throw new Error(`${url} can't go into a hook's command`)
    const server = serverName(orrery.environment)
    const mcp = {mcpServers: {[server]: {...commands.channel, env: {ORRERY_URL: url, ORRERY_ID: orrery.id, ORRERY_PROJECTS: '*', ORRERY_PERSON: '${ORRERY_PERSON:-}'}}}}
    const command = `ORRERY_URL=${url} ORRERY_ID=${orrery.id} ${commands.hook}`
    const hooks = Object.fromEntries(HOOK_EVENTS.map(event => [event, [{hooks: [{type: 'command', command, timeout: 5, ...ASYNC_EVENTS.includes(event) ? {async: true} : {}}]}]]))
    const json = value => `${JSON.stringify(value, null, 2)}\n`
    return {server, files: {'.mcp.json': json(mcp), '.claude/settings.json': json({hooks}), 'CLAUDE.md': HOME_CLAUDE_MD}}
}

const readOr = path => {
    try {
        return readFileSync(path, 'utf8')
    } catch {
        return undefined
    }
}

/** Sets the folder up at `dir`, writing each file that isn't as it should be (by a rename, so nothing reads one half
 * written): `{server, created, written}`, `created` when the folder had none of them yet. */
export function setUpHome(dir, {url, orrery, commands}) {
    const {server, files} = homeFiles({url, orrery, commands})
    const written = []
    let created = true
    for (const [name, text] of Object.entries(files)) {
        const path = join(dir, name)
        const had = readOr(path)
        if (had !== undefined) created = false
        if (had === text) continue
        mkdirSync(dirname(path), {recursive: true})
        const next = `${path}.${process.pid}`
        writeFileSync(next, text)
        renameSync(next, path)
        written.push(name)
    }
    return {server, created, written}
}

/** The projects of an orrery to serve from its default folder: those with no repo that the list doesn't serve from one
 * of this machine's repos. */
export function homeProjects(projects, listed, url) {
    const onList = new Set(listed.filter(entry => entry.url === url).map(entry => entry.project))
    return projects.filter(project => typeof project?.id === 'string' && !project.repo && !onList.has(project.id)).map(project => project.id)
}
