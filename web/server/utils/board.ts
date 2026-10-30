// One check on every write (ORR-654), on an orrery with more than one person: the permissions table's `member` column
// says what a member and their agents may do, and that they're on the board the route names. `authorize` can't do this:
// only the owner-only routes call it. A route the table doesn't name is refused, so a new one can't slip past, and a
// session that names nobody gets only the routes a row says it may (`unnamed`). The owner and their agents go through
// here untouched, and with one person nothing does: what else they're held to is the rest of the table. With no login
// yet these are names, so this keeps honest sessions apart until ORR-664 makes them verified. Reads stay open;
// `needsBoard` is what a read route would call when they don't.
import {createError} from 'h3'
import type {H3Event} from 'h3'
import {PERMISSIONS} from '#shared/permissions'
import {needsPerson, personOf} from './actor'
import {lets, matchRoute} from './guard'
import {notFound} from './input'
import {refusedFor} from './permission'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** What the middleware calls on each request. A chat and an untrusted session have their own guards. */
export async function checkBoards(event: H3Event) {
    if (READS.has(event.method)) return
    const path = event.path.replace(/\/{2,}/g, '/')
    if (!path.startsWith('/api/') || untrustedWrite(event) || chatWrite(event)) return
    const store = useStore()
    if (!await store.severalPeople()) return
    const person = await personOf(event)
    if (person === (await store.ownerOf()).name) return
    const matches = PERMISSIONS.flatMap(row => row.routes.flatMap(route => {
        const params = matchRoute(route, event.method, path)
        return params ? [{row, route, params}] : []
    }))
    const [first] = matches
    if (!first) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: `Nobody has said who may ${event.method} ${path}, so with more than one person on this orrery it's refused`})
    if (!person) {
        if (matches.some(({row, route}) => row.unnamed?.includes(route))) return
        return await needsPerson(event)
    }
    if (first.params.project) await needsBoard(event, decoded(first.params.project))
    for (const {row} of matches) {
        if (await lets(row, 'member', event.method, path, person)) return
    }
    throw refusedFor(first.row.id, `${first.row.action}: the owner's alone for now, or past what ${person} may on this board (${first.row.id}). ${first.row.why}`)
}

/** Refuses a person off `project`, as if it weren't there. A session naming nobody is held by what it called. */
export async function needsBoard(event: H3Event, project: string) {
    if (untrustedWrite(event) || chatWrite(event)) return
    const person = await personOf(event)
    if (person && !await useStore().onBoard(project, person)) throw notFound(`No project ${project}`)
}

/** Those of `projects` a session may hear: its person's boards, and none for a session naming nobody, which is told how
 * to name itself. An untrusted session hears what it was started for. */
export async function boardsHeard(event: H3Event, projects: string[]): Promise<string[]> {
    if (untrustedWrite(event)) return projects
    await needsPerson(event)
    const person = await personOf(event)
    return person ? await useStore().boardsOf(person, projects) : projects
}
