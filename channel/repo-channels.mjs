// A repo's Orrery channels, as its .mcp.json registers them, and the projects the launcher serves from them. A
// monorepo can register several, one per project or per Orrery (`orrery-hub`, `orrery-css` on work's, `orrery` on
// the personal one), so each project's sessions must load the channel that serves it, not the first.
import {readFileSync} from 'node:fs'
import {basename, join} from 'node:path'

const DEFAULT_URL = 'http://localhost:9000'

/** A value from .mcp.json counts only when it's plain, not `${…}` (Claude Code fills those in, we can't). */
const plain = value => typeof value === 'string' && value && !value.includes('${') ? value : undefined
const trim = url => url.replace(/\/+$/, '')

/** Every server in the repo's .mcp.json that runs orrery-channel.mjs, in order: its name and env. */
export function channelsIn(dir) {
    try {
        const servers = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers ?? {}
        return Object.entries(servers)
            .filter(([, s]) => (s.args ?? []).some(a => String(a).includes('orrery-channel.mjs')))
            .map(([name, s]) => ({name, env: s.env ?? {}}))
    } catch {
        return []
    }
}

/** A channel's Orrery (its own `ORRERY_URL`, else the one given, else the default), and the projects it names:
 * each of `ORRERY_PROJECTS`, or `ORRERY_PROJECT`; none for `*`, which serves whatever the Orrery has. */
function served(channel, fallbackUrl) {
    const url = trim(plain(channel.env.ORRERY_URL) ?? fallbackUrl ?? DEFAULT_URL)
    const listed = plain(channel.env.ORRERY_PROJECTS)?.split(',').map(p => p.trim()).filter(Boolean) ?? []
    const every = listed.includes('*')
    const projects = listed.filter(p => p !== '*')
    const one = plain(channel.env.ORRERY_PROJECT)
    return {url, every, projects: projects.length ? projects : one ? [one] : []}
}

/** The projects to serve from the repo at `dir`, each with its Orrery and folder. With `project` (ORRERY_PROJECT),
 * that one, on the Orrery of the channel that names it (or serves every project); without, every project each
 * channel names. `url` (ORRERY_URL) stands in where a channel's own address isn't plain, but doesn't override one
 * that is: a session's own ORRERY_URL would send a monorepo's projects to another Orrery. With no channel naming
 * any, the folder's name. A project no channel serves is on `url`, else the first channel's Orrery. */
export function projectsIn(dir, {project, url} = {}) {
    const channels = channelsIn(dir).map(channel => ({channel, ...served(channel, url)}))
    const unnamed = trim(url ?? channels[0]?.url ?? DEFAULT_URL)
    if (project) {
        const named = channels.find(c => c.projects.includes(project)) ?? channels.find(c => c.every)
        return [{url: named?.url ?? unnamed, project, dir}]
    }
    const seen = new Set()
    const out = []
    for (const c of channels) {
        for (const p of c.projects) {
            const key = `${c.url} ${p}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({url: c.url, project: p, dir})
        }
    }
    return out.length ? out : [{url: unnamed, project: basename(dir), dir}]
}

/** The channel a session for `project` on the Orrery at `url` loads: the one naming that project there, else
 * one serving every project there, else the one naming it anywhere, else the first. Undefined with none. */
export function channelFor(dir, url, project) {
    const channels = channelsIn(dir).map(channel => ({channel, ...served(channel)}))
    const sameOrrery = c => !plain(c.channel.env.ORRERY_URL) || c.url === trim(url)
    const found = channels.find(c => sameOrrery(c) && c.projects.includes(project))
        ?? channels.find(c => sameOrrery(c) && c.every)
        ?? channels.find(c => c.projects.includes(project))
        ?? channels[0]
    return found?.channel
}
