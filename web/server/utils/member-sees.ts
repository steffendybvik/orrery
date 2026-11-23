import type {H3Event} from 'h3'
import type {Who} from './auth'
import {bearer} from './auth'

/** How long the projects someone sees are kept between asks: a project made or shared shows within this, and at once
 * where a miss asks again (`needsSeen`). */
const KEEP_MS = 30_000
const kept = new Map<string, {at: number, projects: Set<string>}>()

/** Whose answer a kept one is: the person, and the key they came with, as an agent key reaches only its own workspace. */
const askerKey = (event: H3Event, who: Who) => `${who.person}\u0000${who.via}\u0000${bearer(event) ?? ''}`

/** The projects anyone signed in can see (ORR-1195), in every workspace they're in, not only the one the request acts
 * in (ORR-1251), asked of the API as them and kept a little while. The server's owner too: owning the server gives no
 * way into another person's workspace (decision 6 of decision-workspaces, ORR-1347). Undefined with login off, who is
 * the only person here, and for the owner with no API to ask. `fresh` asks again whatever is kept. */
export async function memberSees(event: H3Event, {fresh = false} = {}): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const key = askerKey(event, who)
    const now = Date.now()
    const held = kept.get(key)
    if (held && !fresh && now - held.at < KEEP_MS) return held.projects
    const listed = await readAsAsker<{id: string}[]>(event, '/api/projects?every=1')
    // With no API to ask, the owner goes on as before, and a member reaches nothing.
    if (!listed) return who.owner ? undefined : new Set()
    const projects = new Set(listed.map(p => p.id))
    kept.set(key, {at: now, projects})
    return projects
}

const listedKept = new Map<string, {at: number, projects: Set<string>}>()

/** The projects a list across projects shows the asker (ORR-1251): those `GET /api/projects` lists for them, in the
 * one workspace the request is in (`workspace`, else its `Orrery-Workspace`, else `default`), the owner included, so a
 * page doesn't mix workspaces. Undefined with nobody signed in or no API to ask, who see every one. `memberSees`
 * stays the check for reaching one project, which isn't held to the tab's workspace. */
export async function listedSees(event: H3Event, {workspace, fresh = false}: {workspace?: string, fresh?: boolean} = {}): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const named = workspace ?? getHeader(event, 'orrery-workspace') ?? ''
    const key = `${askerKey(event, who)}\u0000${named}`
    const now = Date.now()
    const held = listedKept.get(key)
    if (held && !fresh && now - held.at < KEEP_MS) return held.projects
    const listed = await readAsAsker<{id: string}[]>(event, '/api/projects', workspace ? {workspace} : {})
    if (!listed) return undefined
    const projects = new Set(listed.map(p => p.id))
    listedKept.set(key, {at: now, projects})
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
 * pull request and branch lists keep. Undefined with login off; with no API to ask, the owner's is undefined too, and
 * a member's empty. */
export async function reposSeen(event: H3Event): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who) return undefined
    const listed = await readAsAsker<{repo?: string | null}[]>(event, '/api/projects?every=1')
    if (!listed) return who.owner ? undefined : new Set()
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
