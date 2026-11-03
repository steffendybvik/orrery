// Claiming this orrery from its page (ORR-832), not only from a shell. ORR-664 kept it to the shell so nothing on the
// network could race for an unclaimed server: a page on this machine is as near as the shell, so it may too, and
// anything else is refused. The status route asks the same, so the button shows only where it would work.
import type {H3Event} from 'h3'
import type {Who} from './auth'
import {authMode} from './auth'
import {fromThisMachine, notThisMachine} from './move'
import {refusedFor} from './permission'

/** Why this request may not claim the orrery, or nothing when it may: a page on this machine, while nobody has a person
 * key, and nobody else signed in. With login off it's the owner's page; a session is refused whatever it names.
 * `asking: false` for the status, whose read carries no `Orrery-Actor`: the write that claims does. */
export async function claimRefusal(event: H3Event, {asking = true} = {}): Promise<Error | undefined> {
    if (!fromThisMachine(event)) return refusedFor('auth.claim', notThisMachine('An orrery is claimed'))
    const mode = await authMode(event)
    if (mode === 'closed') return createError({statusCode: 503, statusMessage: 'Service Unavailable', message: 'ORRERY_AUTH=off only works while orrery listens on loopback: unset it'})
    if (await useStore().ownerHasKey()) return conflict('This orrery is claimed already: the owner has a person key')
    if (chatWrite(event) || untrustedWrite(event)) return refusedFor('auth.claim', 'Only a person claims an orrery, never a session')
    const who: Who | undefined = event.context.who
    if (who && (who.via !== 'browser' || !who.owner)) return refusedFor('auth.claim', 'Only the owner claims an orrery, in their own browser')
    if (asking && mode === 'off' && !who) {
        const actor = await actorOf(event)
        // The first page asks the owner's name, and a page that hasn't been through it may claim with one.
        const {named} = await useStore().ownerOf()
        if (named && !actor.owner) return refusedFor('auth.claim', 'Only the owner claims an orrery: send Orrery-Actor: <owner>')
    }
    return undefined
}
