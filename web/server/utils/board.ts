// One check on every write (ORR-654), on an orrery with more than one person: the permissions table's `member` column
// says what a member and their agents may do, and that they're on the board the route names. `authorize` can't do this:
// only the owner-only routes call it. A route the table doesn't name is refused, so a new one can't slip past, and a
// session that names nobody gets only the routes a row says it may (`unnamed`). The owner and their agents go through
// here untouched, and with one person nothing does: what else they're held to is the rest of the table. With login off
// these are names, which keeps honest sessions apart; with it on, the credential decides who's asking (ORR-664). Reads are
// held by the API (`Seen` in api/src/access/seen.rs, ORR-985): a board a member isn't on is a 404 there, and the reads this
// server answers itself follow the projects the API lists to them (middleware/board-reads.ts, ORR-1195).
import {createError} from 'h3'
import type {H3Event} from 'h3'
import {PERMISSIONS} from '#shared/permissions'
import {needsPerson, personOf} from './actor'
import {boardsOf, isShared, onBoard, ownerNow} from './roster'
import {lets, matchRoute} from './guard'
import {memberSees} from './member-sees'
import {notFound} from './input'
import {refusedFor} from './permission'

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** What the middleware calls on each request. A chat and an untrusted session have their own guards. */
export async function checkBoards(event: H3Event) {
    if (READS.has(event.method)) return
    const path = event.path.replace(/\/{2,}/g, '/')
    if (!path.startsWith('/api/') || untrustedWrite(event) || chatWrite(event)) return
    if (!await isShared()) return
    const person = await personOf(event)
    if (person === (await ownerNow()).name) return
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
    if (person && !await onBoard(project, person)) throw notFound(`No project ${project}`)
}

/** Those of `projects` a session may hear: its person's boards, and none for a session naming nobody, which is told how
 * to name itself. An untrusted session hears what it was started for. */
export async function boardsHeard(event: H3Event, projects: string[]): Promise<string[]> {
    // Only the projects its credential sees (ORR-1347): none in another person's workspace, the owner's sessions too.
    // The untrusted mark narrows what a session hears, never widens it, so it's held to this as well (ORR-1372).
    const sees = await memberSees(event)
    const seen = sees ? projects.filter(p => sees.has(p)) : projects
    if (untrustedWrite(event)) return seen
    await needsPerson(event)
    const person = await personOf(event)
    return person ? await boardsOf(person, seen) : seen
}
