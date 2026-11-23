import type {H3Event} from 'h3'
import type {Who} from './auth'
import {bearer} from './auth'

/** How long the projects someone sees are kept between asks: a project made or shared shows within this, and at once
 * where a miss asks again (`needsSeen`). */
const KEEP_MS = 30_000
/** How soon after a fresh ask another may go for the same asker (ORR-1409): the first miss still asks again, so a
 * project made a moment ago is reached at once, but a loop over projects someone can't see costs one ask every so
 * often, not one a request. */
const FRESH_MS = 2_000
/** The most askers kept at once (ORR-1409): past it, those gone stale go first, then the longest kept. */
const KEEP_MOST = 1_000
type Kept = Map<string, {at: number, projects: Set<string>, fresh?: number}>
const kept: Kept = new Map()

/** Keeps `projects` for `key`, at the end, so the longest kept are first; lets go of stale ones once there are many. */
function keep(map: Kept, key: string, projects: Set<string>, now: number, fresh?: number) {
    map.delete(key)
    if (map.size >= KEEP_MOST) {
        for (const [k, v] of map) if (now - v.at >= KEEP_MS) map.delete(k)
        for (const k of map.keys()) {
            if (map.size < KEEP_MOST) break
            map.delete(k)
        }
    }
    map.set(key, {at: now, projects, ...fresh ? {fresh} : {}})
}

/** Whether what's kept answers: within `KEEP_MS`, and when asked `fresh`, unless a fresh ask went in the last `FRESH_MS`. */
const answers = (held: {at: number, fresh?: number} | undefined, now: number, fresh: boolean): held is {at: number, fresh?: number} =>
    !!held && now - held.at < KEEP_MS && (!fresh || (held.fresh !== undefined && now - held.fresh < FRESH_MS))

/** Whose answer a kept one is: the person, and the key they came with, as an agent key reaches only its own workspace. */
const askerKey = (event: H3Event, who: Who) => `${who.person}\u0000${who.via}\u0000${bearer(event) ?? ''}`

/** The projects anyone signed in can see (ORR-1195), in every workspace they're in, not only the one the request acts
 * in (ORR-1251), asked of the API as them and kept a little while. The server's owner too: owning the server gives no
 * way into another person's workspace (decision 6 of decision-workspaces, ORR-1347). Undefined with login off, who is
 * the only person here. With no answer from the API, none, the owner's too, and nothing kept (ORR-1368): a read that
 * failed never widens what anyone sees. `fresh` asks again, unless a fresh ask went in the last `FRESH_MS`. */
export async function memberSees(event: H3Event, {fresh = false} = {}): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const key = askerKey(event, who)
    const now = Date.now()
    const held = kept.get(key)
    if (held && answers(held, now, fresh)) return held.projects
    const listed = await readAsAsker<{id: string}[]>(event, '/api/projects?every=1')
    if (!listed) return new Set()
    const projects = new Set(listed.map(p => p.id))
    keep(kept, key, projects, now, fresh ? now : undefined)
    return projects
}

const listedKept: Kept = new Map()

/** The projects a list across projects shows the asker (ORR-1251): those `GET /api/projects` lists for them, in the
 * one workspace the request is in (`workspace`, else its `Orrery-Workspace`, else `default`), the owner included, so a
 * page doesn't mix workspaces. Undefined with nobody signed in, who sees every one; none for anyone signed in when the
 * API gives no answer (ORR-1368), as `undefined` means every workspace's rows to its callers. `memberSees`
 * stays the check for reaching one project, which isn't held to the tab's workspace. */
export async function listedSees(event: H3Event, {workspace, fresh = false}: {workspace?: string, fresh?: boolean} = {}): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const named = workspace ?? getHeader(event, 'orrery-workspace') ?? ''
    const key = `${askerKey(event, who)}\u0000${named}`
    const now = Date.now()
    const held = listedKept.get(key)
    if (held && answers(held, now, fresh)) return held.projects
    const listed = await readAsAsker<{id: string}[]>(event, '/api/projects', workspace ? {workspace} : {})
    if (!listed) return new Set()
    const projects = new Set(listed.map(p => p.id))
    keep(listedKept, key, projects, now, fresh ? now : undefined)
    return projects
}

/** A 404 for a project the asker can't see, as if it weren't here. A miss asks the API again first, so a project made
 * a moment ago is reached at once. */
export async function needsSeen(event: H3Event, project: string) {
    const sees = await memberSees(event)
    if (!sees || sees.has(project)) return
    const now = await memberSees(event, {fresh: true})
    if (now && !now.has(project)) throw createError({statusCode: 404, statusMessage: 'Not Found', message: `No project ${project}`})
}

/** The projects listed to the request's asker (ORR-1195, ORR-1347): anyone signed in, the owner too, those the API
 * lists for them; with login off, every one, as this server reads them. */
export async function projectsListedTo<T>(event: H3Event, every: () => Promise<T[]>): Promise<T[]> {
    const who = event.context?.who as Who | undefined
    if (who) return await readAsAsker<T[]>(event, '/api/projects') ?? []
    return await every()
}

/** The GitHub repos (lowercased) of the projects the asker can see, in every workspace they're in (ORR-1347): what the
 * pull request and branch lists keep. Undefined with login off; with no answer from the API, empty, the owner's too
 * (ORR-1368). */
export async function reposSeen(event: H3Event): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const listed = await readAsAsker<{repo?: string | null}[]>(event, '/api/projects?every=1')
    if (!listed) return new Set()
    return new Set(listed.flatMap(p => p.repo ? [p.repo.toLowerCase()] : []))
}

/** The workspace a request's `Orrery-Workspace` names, once the asker is in it (ORR-1369): what a route that writes
 * as this server, which the API trusts with any workspace it names, passes on. None named is the API's `default`.
 * With login off, the one person here is in every one; signed in, a workspace that `GET /api/workspaces` doesn't list
 * for them, or no answer from it, is a 404, as one that isn't here. */
export async function workspaceAsked(event: H3Event): Promise<string | undefined> {
    const named = getHeader(event, 'orrery-workspace')?.trim() || undefined
    const who = event.context?.who as Who | undefined
    if (!named || !who) return named
    const theirs = await readAsAsker<{id: string}[]>(event, '/api/workspaces')
    if (!theirs?.some(w => w.id === named)) throw createError({statusCode: 404, statusMessage: 'Not Found', message: `No workspace ${named}`})
    return named
}

/** The workspace a request acts in, as the API picks it for the asker (ORR-1377): the one `Orrery-Workspace` names once
 * they're in it, else `default` when they're in it, else their first. One naming a workspace they aren't in is kept in
 * theirs the same way (ORR-1409), so a probe of another workspace is still logged, and only where they can read it.
 * Undefined with login off, where every line is the one person's; null for someone signed in who's in no workspace, or
 * when the API gives no answer. What a line in the event log about their request is kept in, so it's theirs to read and
 * nobody else's. */
export async function askerWorkspace(event: H3Event): Promise<string | null | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const named = getHeader(event, 'orrery-workspace')?.trim() || undefined
    const theirs = await readAsAsker<{id: string}[]>(event, '/api/workspaces')
    if (!theirs?.length) return null
    if (named && theirs.some(w => w.id === named)) return named
    return (theirs.find(w => w.id === 'default') ?? theirs[0])?.id ?? null
}

/** The project a request names in its body (ORR-1359), only when the asker sees it and, for a session, it's in the
 * workspace the session works in: any other is answered as one that isn't here, the same 404, so a body can neither
 * reach another workspace's project nor find out that it exists. `heldToWorkspace` only reads a project in the path. */
export async function seenProjectOf(event: H3Event, named: string): Promise<string> {
    const hidden = () => notFound(`No project "${named}"`)
    try {
        const project = await useStore().projectId(named)
        await needsSeen(event, project)
        const held = sessionWorkspace(event)
        if (held && await useStore().projectWorkspace(project) !== held) throw hidden()
        return project
    } catch (error) {
        if ((error as {statusCode?: number}).statusCode === 404) throw hidden()
        throw error
    }
}
