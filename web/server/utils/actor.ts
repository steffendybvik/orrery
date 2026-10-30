import type {H3Event} from 'h3'
import type {Actor} from './store'
import type {Who} from './auth'
import {actorId} from '../store/schema'

// Who's asking, by the `Orrery-Actor` header (`agent` without one). There's no auth: it's what
// keeps an agent from deleting what the owner (their id, from the name they gave) made, as long as
// agents name themselves.
// A session's write (`Orrery-Session`) carries that session's name too (ORR-466), to keep with what it wrote.
/** The Claude session a request says it's from (`Orrery-Session`), as the channel's tools and the hooks send it. */
export function sessionHeader(event: H3Event): string | undefined {
    return getHeader(event, 'orrery-session')?.trim() || undefined
}

/** Who a credential says this request is, once the auth middleware has checked it (`Who`); nothing with auth off. */
const verified = (event: H3Event): Who | undefined => event.context?.who

export async function actorOf(event: H3Event): Promise<Actor> {
    // With auth on (ORR-664) the credential decides: a person logged in is that person, and an agent key is an agent
    // whatever name it sends, with a label that's a person's name counting for nothing.
    const who = verified(event)
    if (who?.via === 'browser') return {name: who.person, owner: who.owner, asked: true, named: who.person, ...who.owner ? {} : {person: who.person}}
    if (who) {
        const label = getHeader(event, 'orrery-actor')?.trim().slice(0, 60) || 'agent'
        const session = sessionName(sessionHeader(event))
        return {name: await useStore().isPerson(label) ? 'agent' : label, owner: false, asked: true, named: who.person, ...untrustedWrite(event) ? {untrusted: true} : {}, ...session ? {session} : {}, ...chatWrite(event) ? {chat: true} : {}}
    }
    const name = getHeader(event, 'orrery-actor')?.trim().slice(0, 60) || 'agent'
    const owner = name.toLowerCase() === (await useStore().ownerOf()).name
    const session = owner ? undefined : sessionName(sessionHeader(event))
    const named = personHeader(event)
    const person = await personActing(event, name, owner, named)
    return {name, owner, asked: true, ...untrustedWrite(event) ? {untrusted: true} : {}, ...session ? {session} : {}, ...named ? {named} : {}, ...chatWrite(event) ? {chat: true} : {}, ...person ? {person} : {}}
}

/** The member a request with no credential names as itself, by `Orrery-Actor` (ORR-658), on an orrery with more than one
 * person. An agent working for them says so with `Orrery-Person` under a name of its own. */
async function personActing(event: H3Event, name: string, owner: boolean, named: string | undefined): Promise<string | undefined> {
    if (untrustedWrite(event) || chatWrite(event)) return undefined
    if (owner) return undefined
    const id = actorId(name)
    if (named && actorId(named) !== id) return undefined
    return await useStore().personFor(name) === id ? id : undefined
}

/** Whose a request is (ORR-653): the owner's, and their chat's, whatever they send; a session's, the person it names
 * (`Orrery-Person`, from `ORRERY_PERSON`), or a person naming themselves (`Orrery-Actor`); and an untrusted session's
 * nobody's. Worked out each time from what it sends, so a restart or a `/clear` changes nothing. */
export async function personOf(event: H3Event): Promise<string | undefined> {
    if (untrustedWrite(event)) return undefined
    const who = verified(event)
    if (who) return who.person
    const {owner, name} = await actorOf(event)
    if (owner) return name.toLowerCase()
    return chatWrite(event) ? (await useStore().ownerOf()).name : await useStore().personFor(personHeader(event) ?? name)
}

const personHeader = (event: H3Event) => getHeader(event, 'orrery-person')?.trim() || undefined

/** Refuses a change to an issue from a session that can't say whose it is, on an orrery with more than one person: it
 * can still read and comment. An untrusted session has its own guard. */
export async function needsPerson(event: H3Event) {
    if (untrustedWrite(event) || await personOf(event)) return
    const named = personHeader(event)
    throw conflict(`${named ? `"${named}" isn't anyone on this orrery` : 'This session names nobody'}, and this orrery has more than one person, so it can read and comment but can't take up or change an issue. Set ORRERY_PERSON to your id (GET /api/people) where you start Claude Code, or send Orrery-Person.`)
}

/** The issue a write went to is the work of the session that says it made it (`Orrery-Session`), if one
 * does, so the owner's comments on it, and their decision on a proposal, go to that session. Not a chat's: what it
 * makes is for others to work. */
export function workedOn(event: H3Event, issue: {project: string, id: string}) {
    const session = sessionHeader(event)
    if (chatWrite(event)) return
    // The channel's id may be from before a `/clear`: the issue goes to the session as it is now.
    if (session) useStore().workedBy(issue.project, issue.id, currentId(session)).catch(() => {})
}

/** Refuses a session's (`Orrery-Session`) write to an issue another session is on (`Store.claim`), so two sessions
 * don't both take it up. The owner's writes never are. */
export async function claimFor(event: H3Event, project: string, issue: string) {
    const session = sessionHeader(event)
    if (session && !(await actorOf(event)).owner) await useStore().claim(project, issue, undefined, currentId(session))
}
