import type {H3Event} from 'h3'
import type {Actor} from './store'

// Who's asking, by the `Orrery-Actor` header (`agent` without one). There's no auth: it's what
// keeps an agent from deleting what the owner (their id, from the name they gave) made, as long as
// agents name themselves.
export async function actorOf(event: H3Event): Promise<Actor> {
    const name = getHeader(event, 'orrery-actor')?.trim().slice(0, 60) || 'agent'
    return {name, owner: name.toLowerCase() === (await useStore().ownerOf()).name, ...untrustedWrite(event) ? {untrusted: true} : {}}
}

/** The issue a write went to is the work of the session that says it made it (`Orrery-Session`), if one
 * does, so the owner's comments on it, and their decision on a proposal, go to that session. Not a chat's: what it
 * makes is for others to work. */
export function workedOn(event: H3Event, issue: {project: string, id: string}) {
    const session = getHeader(event, 'orrery-session')?.trim()
    if (chatWrite(event)) return
    // The channel's id may be from before a `/clear`: the issue goes to the session as it is now.
    if (session) useStore().workedBy(issue.project, issue.id, currentId(session)).catch(() => {})
}

/** Refuses a session's (`Orrery-Session`) write to an issue another session is on (`Store.claim`), a comment as much
 * as starting it, so two sessions don't both take it up. The owner's writes never are. */
export async function claimFor(event: H3Event, project: string, issue: string) {
    const session = getHeader(event, 'orrery-session')?.trim()
    if (session && !(await actorOf(event)).owner) await useStore().claim(project, issue, undefined, currentId(session))
}
