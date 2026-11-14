import type {H3Event} from 'h3'
import type {Who} from './auth'

/** How long a member's projects are kept between asks: a project made or shared shows within this. */
const KEEP_MS = 30_000
const kept = new Map<string, {at: number, projects: Set<string>}>()

/** The projects a signed-in member who isn't the owner can see (ORR-1195), asked of the API as them and kept a little
 * while; undefined for the owner, their agents and anyone with login off, who see every one. */
export async function memberSees(event: H3Event): Promise<Set<string> | undefined> {
    const who = event.context?.who as Who | undefined
    if (!who || who.owner) return undefined
    const now = Date.now()
    const held = kept.get(who.person)
    if (held && now - held.at < KEEP_MS) return held.projects
    const projects = new Set((await readAsAsker<{id: string}[]>(event, '/api/projects') ?? []).map(p => p.id))
    kept.set(who.person, {at: now, projects})
    return projects
}

/** A 404 for a project a member can't see, as if it weren't here. */
export async function needsSeen(event: H3Event, project: string) {
    const sees = await memberSees(event)
    if (sees && !sees.has(project)) throw createError({statusCode: 404, statusMessage: 'Not Found', message: `No project ${project}`})
}
