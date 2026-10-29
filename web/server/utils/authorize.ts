// The permissions table (shared/permissions.ts) as what's enforced, not only what's shown (ORR-512): a route calls
// `authorize(event, '<row id>')`, which reads that row's cell for whoever is asking and lets them through or refuses them
// with a 403 naming the row. What a `limited` cell limits is still held where it's checked (the store, the chat's and an
// untrusted session's guards); this is the yes or no.
import type {H3Event} from 'h3'
import type {Permission, SessionKind} from '#shared/permissions'
import {permission, refused} from './permission'
import type {Actor} from './store'

/** Who's asking, as the table's columns see them: the owner, or one of its kinds of session. An untrusted session and
 * the owner's chat are known by what their channel sends, whatever name they give, so a chat naming the owner is still
 * the chat. */
export type ActorKind = 'owner' | SessionKind

export function kindOf(event: H3Event, actor: Actor): ActorKind {
    if (untrustedWrite(event)) return 'untrusted'
    if (chatWrite(event)) return 'chat'
    return actor.owner ? 'owner' : 'session'
}

/** Whether `kind` may call the route itself: the owner may do anything, and a session what its cell lets it, within the
 * cell's limits where they're checked. `asks` is done only through the owner's Allow or Send, so never straight. */
export function allows(row: Permission, kind: ActorKind): boolean {
    if (kind === 'owner') return true
    return ['free', 'limited', 'owned'].includes(row[kind].level)
}

/** Lets the request through if the table lets whoever's asking do `id`, else throws its 403. The actor, for the route. */
export async function authorize(event: H3Event, id: string): Promise<Actor> {
    const row = permission(id)
    const actor = await actorOf(event)
    const kind = kindOf(event, actor)
    if (kind !== 'owner' && !allows(row, kind)) throw refused(row, kind)
    return actor
}
