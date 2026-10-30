// The owner's chat and an untrusted schedule's session are held, at the door, to what the permissions table's column
// for them says (ORR-512): a write goes through only on a route of a row their cell lets them do (`free`, `limited`),
// one of the cell's own `routes` when it names them, and past the cell's `check` when it has one. Anything else, a
// route no row names included, is refused. The routes still hold the rest of a `limited` cell's limit (the chat's
// issues unstarted and unassigned, an untrusted session's made proposals).
import {createError} from 'h3'
import type {H3Event} from 'h3'
import {PERMISSIONS} from '#shared/permissions'
import type {Permission, PermissionCell} from '#shared/permissions'

/** A row's route (`POST /api/projects/:project/issues`) as a request matches it: its method, and its path with each
 * `:name` one part, a trailing slash or a query allowed. */
interface Route {
    method: string
    pattern: RegExp
    names: string[]
}

function compile(route: string): Route {
    const [method, path] = route.split(' ') as [string, string]
    const names: string[] = []
    const body = path.split('/').map(part => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        names.push(part.slice(1))
        return '([^/?]+)'
    }).join('/')
    return {method, pattern: new RegExp(`^${body}/?(\\?|$)`), names}
}

const compiled = new Map<string, Route>()
function routeOf(route: string): Route {
    let found = compiled.get(route)
    if (!found) compiled.set(route, found = compile(route))
    return found
}

/** The request's parameters if it's `route` (as they came, still escaped), else null. */
export function matchRoute(route: string, method: string, path: string): Record<string, string> | null {
    const {method: wanted, pattern, names} = routeOf(route)
    if (method !== wanted) return null
    const found = pattern.exec(path)
    return found ? Object.fromEntries(names.map((name, i) => [name, found[i + 1] ?? ''])) : null
}

/** The limits a cell names, held here as the request comes in: true lets it through. */
const LIMITS: Record<NonNullable<PermissionCell['check']>, (params: Record<string, string>, person?: string) => Promise<boolean>> = {
    /** A comment only on one of the proposals an untrusted session raised: pending, labelled `external`. */
    externalProposal: async ({project, issue}) => {
        const found = project && issue ? await useStore().issue(decoded(project), decoded(issue)).catch(() => null) : null
        return found?.proposal === 'pending' && found.labels.includes(EXTERNAL)
    },
    /** Only the person holding the board the route names (ORR-654). */
    boardHolder: async ({project}, person) => !!project && !!person && await useStore().holdsBoard(decoded(project), person),
}

/** Whether `kind` may make this write: a row its cell allows, on a route the cell allows, past its check (`person`
 * being the member asking). */
export async function lets(row: Permission, kind: 'chat' | 'untrusted' | 'member', method: string, path: string, person?: string): Promise<boolean> {
    const cell = row[kind]
    if (cell.level !== 'free' && cell.level !== 'limited') return false
    for (const route of cell.routes ?? row.routes) {
        const params = matchRoute(route, method, path)
        if (params && (!cell.check || await LIMITS[cell.check](params, person))) return true
    }
    return false
}

/** Refuses `kind`'s write unless the table lets it, naming what it's for. Reads go through. */
export async function guard(event: H3Event, kind: 'chat' | 'untrusted', refusedFor: string) {
    if (event.method === 'GET' || event.method === 'HEAD') return
    for (const row of PERMISSIONS) {
        if (await lets(row, kind, event.method, event.path)) return
    }
    const row = PERMISSIONS.find(p => p.routes.some(route => matchRoute(route, event.method, event.path)))
    throw createError({statusCode: 403, statusMessage: 'Forbidden', message: refusedFor, ...row ? {data: {permission: row.id}} : {}})
}
