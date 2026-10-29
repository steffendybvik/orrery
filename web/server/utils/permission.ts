// The permissions table's refusals (ORR-512), for the routes (`authorize`), the guards (`guard`) and the store alike:
// each 403 says what the table says and why, with the row's id in its data (`permission`), which the event log's
// `request.refused` keeps, so a refusal leads to its row on the Permissions tab. Plain imports only, so the store's
// tests can use it outside Nuxt.
import {createError} from 'h3'
import {PERMISSIONS, PERMISSION_LEVELS} from '#shared/permissions'
import type {Permission, SessionKind} from '#shared/permissions'

/** The row for `id`; a name that isn't in the table is a bug in the caller, not the request. */
export function permission(id: string): Permission {
    const row = PERMISSIONS.find(p => p.id === id)
    if (!row) throw new Error(`No permission ${id} in shared/permissions.ts`)
    return row
}

/** A 403 for row `id` with a message of the caller's own: what a `limited` cell's limit refused, in its words. */
export function refusedFor(id: string, message: string) {
    return createError({statusCode: 403, statusMessage: 'Forbidden', message, data: {permission: permission(id).id}})
}

/** The 403 for `kind` doing `row` at all: what its cell says, and the row's why. */
export function refused(row: Permission, kind: SessionKind) {
    const cell = row[kind]
    const how = cell.level === 'asks' ? 'asked of the owner, never done straight' : PERMISSION_LEVELS[cell.level].toLowerCase()
    return refusedFor(row.id, `${row.action}: ${how} for ${kind === 'session' ? 'a session' : kind === 'chat' ? "the owner's chat" : 'an untrusted session'} (${row.id}). ${row.why}`
        + (kind === 'session' && cell.level === 'owner' ? ' Send Orrery-Actor: <owner>' : ''))
}

/** Refuses anyone but the owner row `id`, where the store or a util holds it rather than a route. */
export function ownerOnly(actor: {owner: boolean, untrusted?: boolean}, id: string) {
    if (!actor.owner) throw refused(permission(id), actor.untrusted ? 'untrusted' : 'session')
}
