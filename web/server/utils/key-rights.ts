// Who may handle keys (ORR-664): a person, never a session, whatever key it has. With auth on that's whoever is logged in,
// each for themselves, and the owner for others too, as a server with no provider signs members in with a key the owner
// gave them. With auth off, only the owner, by name.
import type {H3Event} from 'h3'
import type {Who} from './auth'

/** The person making the request, and whether they may act for others; refuses anything else. */
export async function keyHolderOf(event: H3Event): Promise<{person: string, owner: boolean}> {
    const who: Who | undefined = event.context.who
    if (who?.via === 'browser') return {person: who.person, owner: who.owner}
    const actor = await authorize(event, 'keys.write')
    if (who || !actor.owner) throw refusedFor('keys.write', 'Only a person handles keys, never a session')
    return {person: actor.name.toLowerCase(), owner: true}
}
