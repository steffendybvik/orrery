// Which of Claude Code's MCP logs is this channel's (ORR-1321). The channel learns whether Claude Code took it on as a
// channel from the log Claude Code keeps per server name, and it can't see its own name. With several orrerys'
// channels in one session (`orrery` on one, `orrery-personal` on another), a name that only looks like its own can be
// another orrery's, whose "skipped" line would tell this orrery the session hears nothing.
import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

/** A value from Claude Code's config counts only when it's plain, not `${…}` (Claude Code fills those in, we can't). */
const plain = value => typeof value === 'string' && value && !value.includes('${') ? value : undefined
const trim = url => url.replace(/\/+$/, '')
const read = path => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return undefined
    }
}

/** The names of MCP servers in Claude Code's config for the folder `dir` that point at another orrery than the one at
 * `url` with id `id`: by a plain `ORRERY_ID` that isn't `id`, else by a plain `ORRERY_URL` that isn't `url`. A name is
 * taken as Claude Code takes it, the folder's own (`~/.claude.json`'s `projects`) over the repo's `.mcp.json` over the
 * user's. One that doesn't say where it points isn't counted. */
export function serversElsewhere(dir, {url, id}, home = homedir()) {
    const claude = read(join(home, '.claude.json')) ?? {}
    const servers = {...claude.mcpServers, ...read(join(dir, '.mcp.json'))?.mcpServers, ...claude.projects?.[dir]?.mcpServers}
    const elsewhere = new Set()
    for (const [name, server] of Object.entries(servers)) {
        const env = server?.env ?? {}
        const theirId = plain(env.ORRERY_ID)
        const theirUrl = plain(env.ORRERY_URL)
        if (theirId && id ? theirId !== id : theirUrl && url ? trim(theirUrl) !== trim(url) : false) elsewhere.add(name)
    }
    return elsewhere
}

/** Whether Claude Code took the channel on, from its logs (`{name, text, at}`, any order): the newest one with lines
 * for `session` (all of it when the session isn't known), read from those lines alone. `unknown` when none says. */
export function channelIn(logs, session) {
    const lines = text => session ? text.split('\n').filter(line => line.includes(session)).join('\n') : text
    for (const log of [...logs].sort((a, b) => b.at - a.at)) {
        const text = lines(log.text)
        if (!text) continue
        if (text.includes('Channel notifications registered')) return {channel: 'yes', server: log.name}
        if (text.includes('Channel notifications skipped')) return {channel: 'no', server: log.name}
        return {channel: 'unknown', server: log.name}
    }
    return {channel: 'unknown'}
}
