// Connect a repo with a click (ORR-708): what the launcher writes into a repo, in code rather than through an agent, so it
// comes out the same every time and is safe to run again. It keeps what's in each file already, folds older setups as
// the Connect brief says, and adds projects to the entry that's there. The address is the launcher's own and the rest
// is checked here, so orrery can't put anything but a project's name for itself into a hook or a committed file.
// web/shared/connect.ts writes the same pieces for the brief, and test/repo-setup.test.ts holds the two together.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {channelsIn, served} from './repo-channels.mjs'
import {serverName} from './server-name.mjs'

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']
const ASYNC_EVENTS = ['PreToolUse', 'PermissionRequest']
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,99}$/
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,19}$/
const ORRERY_ID = /^[A-Za-z0-9_-]{1,100}$/
const trim = url => url.replace(/\/+$/, '')

/** The JSON file at `path` as an object, `{}` when it's missing. One that can't be read as JSON stops the setup, as
 * writing over it would lose what's in it. */
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

/** Whether a channel in .mcp.json is for this orrery: the same `ORRERY_ID`, or the same `ORRERY_URL`. */
const forOrrery = (channel, url, id) => channel.env.ORRERY_ID === id || served(channel).url === trim(url)

/** The projects the repo at `dir` already has on this orrery, and whether its channel serves them all (`*`). */
export function connectedIn(dir, {url, id}) {
    const channels = channelsIn(dir).filter(channel => forOrrery(channel, url, id)).map(channel => served(channel))
    return {projects: [...new Set(channels.flatMap(channel => channel.projects))], every: channels.some(channel => channel.every)}
}

/** `.mcp.json` with one entry for this orrery serving these projects: the entry that lists its projects if there is
 * one (keeping its name), with any others for this orrery folded in, on the bootstrap. Other servers stay as they are. */
function mergedMcp(config, dir, {url, orrery, projects}) {
    const ours = channelsIn(dir).filter(channel => forOrrery(channel, url, orrery.id))
    const lists = ours.filter(channel => channel.env.ORRERY_PROJECTS)
    const name = lists[0]?.name ?? serverName(orrery.environment)
    const servers = {...config.mcpServers}
    if (servers[name] && !ours.some(channel => channel.name === name)) throw new Error(`.mcp.json already has a server called ${name}, for something else: rename it and try again`)
    const had = ours.map(channel => served(channel))
    const every = had.some(channel => channel.every)
    const listed = [...new Set([...had.flatMap(channel => channel.projects), ...projects.map(project => project.id)])]
    const {ORRERY_PROJECT: _, ...kept} = servers[name]?.env ?? {}
    const entry = {
        ...servers[name],
        command: 'node',
        args: ['${HOME}/.orrery/bootstrap.mjs', 'channel'],
        env: {
            ...kept,
            ORRERY_URL: url,
            ORRERY_ID: orrery.id,
            ORRERY_PROJECTS: every ? '*' : listed.join(','),
            // From the user's environment: this file is committed, so a name in it would make every clone that person.
            ORRERY_PERSON: '${ORRERY_PERSON:-}',
        },
    }
    for (const channel of ours) if (channel.name !== name) delete servers[channel.name]
    return {server: name, listed, config: {...config, mcpServers: {...servers, [name]: entry}}}
}

const isOrreryHook = command => /orrery-hook\.mjs|bootstrap\.mjs"?\s+hook\b/.test(command ?? '')
const hookIsFor = (command, url, id) => command.includes(`ORRERY_ID=${id}`) || command.includes(`ORRERY_URL=${url}`) || !command.includes('ORRERY_URL=')

/** The project a repo's hooks report under, if it has them on this orrery. */
function hookProject(config, url, id) {
    for (const groups of Object.values(config.hooks ?? {})) {
        for (const group of Array.isArray(groups) ? groups : []) {
            for (const {command} of group.hooks ?? []) {
                if (isOrreryHook(command) && hookIsFor(command, url, id)) return /ORRERY_PROJECT=([^\s]+)/.exec(command)?.[1]
            }
        }
    }
}

/** `.claude/settings.json` with orrery's hook on each event: where it was for this orrery, else added. Other hooks, and
 * this repo's hooks for another orrery, stay as they are. */
function mergedSettings(config, {url, orrery, project}) {
    const command = `ORRERY_PROJECT=${project} ORRERY_URL=${url} ORRERY_ID=${orrery.id} node "$HOME/.orrery/bootstrap.mjs" hook`
    const hooks = {...config.hooks}
    for (const event of HOOK_EVENTS) {
        const hook = {type: 'command', command, timeout: 5, ...ASYNC_EVENTS.includes(event) ? {async: true} : {}}
        let placed = false
        const groups = (Array.isArray(hooks[event]) ? hooks[event] : []).map(group => ({
            ...group,
            hooks: (group.hooks ?? []).flatMap(one => {
                if (!isOrreryHook(one.command) || !hookIsFor(one.command, url, orrery.id)) return [one]
                if (placed) return []
                placed = true
                return [hook]
            }),
        })).filter(group => group.hooks.length)
        hooks[event] = placed ? groups : [...groups, {hooks: [hook]}]
    }
    return {...config, hooks}
}

/** The Roadmap section for CLAUDE.md, as the brief has it (`web/shared/connect.ts`). */
export function roadmapSection(url, projects) {
    const named = projects.map(({id, key}) => `\`${id}\` (issue ids \`${key}-n\`)`).join(', ')
    const where = projects.length === 1 ? `project \`${projects[0].id}\`, issue ids \`${projects[0].key}-n\`` : `projects ${named}`
    return `## Roadmap

The roadmap is in orrery (${url}), ${where}. How to use it: \`curl -s ${url}/llms-full.txt\`.

- Work from an issue: set it to \`in-progress\` (assignee \`claude\`) before starting, comment as it moves, \`done\` when it ships (\`canceled\` when it's dropped).
- Knowledge (decisions, how things work) goes in the project's docs.
- Send \`Orrery-Actor: claude\` on every write. orrery hands out ids; don't send one.
- With orrery's server in \`.mcp.json\`, its tools (\`issue\`, \`start_issue\`, \`comment\`, \`finish_issue\`, …) do all of this without curl.`
}

/** CLAUDE.md with the section: in place of one this wrote for the same orrery, or added at the end. A Roadmap section of
 * the repo's own that names this orrery was written by someone, so it stays. */
function mergedClaudeMd(text, url, projects) {
    const section = roadmapSection(url, projects)
    const lines = text.split('\n')
    const heads = lines.flatMap((line, at) => line.trim() === '## Roadmap' ? [at] : [])
    const body = at => {
        const end = lines.findIndex((line, i) => i > at && /^##?\s/.test(line))
        return {end: end < 0 ? lines.length : end, text: lines.slice(at + 1, end < 0 ? undefined : end).join('\n')}
    }
    const mine = heads.find(at => body(at).text.includes(`The roadmap is in orrery (${url})`))
    if (mine === undefined) {
        if (heads.some(at => body(at).text.includes(url))) return text
        return text.trim() ? `${text.trimEnd()}\n\n${section}\n` : `${section}\n`
    }
    const after = lines.slice(body(mine).end).join('\n')
    const before = lines.slice(0, mine).join('\n')
    return `${before ? `${before}\n` : ''}${section}\n${after ? `\n${after}` : ''}`
}

/** Writes `text` by a rename, so nothing reads it half written. */
function writeWhole(path, text) {
    mkdirSync(dirname(path), {recursive: true})
    const next = `${path}.${process.pid}`
    writeFileSync(next, text)
    renameSync(next, path)
}

/** Sets the repo at `dir` up for the orrery at `url` with `projects` ({id, key}) added to what it has: works out all
 * three files first, so a problem with one writes none, then writes those that change. `{server, written, unchanged}`. */
export function setUpRepo(dir, {url: given, orrery, projects}) {
    const url = trim(given)
    if (!ORRERY_ID.test(orrery?.id ?? '')) throw new Error('orrery sent an id that this launcher won\'t write into a file')
    for (const {id, key} of projects) {
        if (!PROJECT_ID.test(id ?? '') || !PROJECT_KEY.test(key ?? '')) throw new Error(`orrery sent a project (${String(id).slice(0, 40)}) that this launcher won't write into a file`)
    }
    const mcpPath = join(dir, '.mcp.json')
    const settingsPath = join(dir, '.claude', 'settings.json')
    const claudePath = join(dir, 'CLAUDE.md')
    const settings = readJson(settingsPath)
    const {server, listed, config: mcp} = mergedMcp(readJson(mcpPath), dir, {url, orrery, projects})
    const project = hookProject(settings, url, orrery.id) ?? listed[0]
    if (!project) throw new Error('Tick a project for this repo first')
    const claudeMd = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : ''
    const json = value => `${JSON.stringify(value, null, 2)}\n`
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const next = mergedSettings(settings, {url, orrery, project})
    const merged = mergedClaudeMd(claudeMd, url, projects)
    const files = [
        ['.mcp.json', mcpPath, sameJson(readJson(mcpPath), mcp), json(mcp)],
        ['.claude/settings.json', settingsPath, sameJson(settings, next), json(next)],
        ['CLAUDE.md', claudePath, merged === claudeMd, merged],
    ]
    const written = []
    const unchanged = []
    for (const [name, path, same, text] of files) {
        if (same) unchanged.push(name)
        else {
            writeWhole(path, text)
            written.push(name)
        }
    }
    return {server, written, unchanged, projects: listed}
}
