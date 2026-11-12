// Who's on this orrery and on each board, as the checks on every request read it (ORR-1138): the owner, the people and
// a board's members come from the Rust API once one is set up (`GET /api/owner`, `/api/people`,
// `/api/projects/:p/members`), so those checks open no database here. Each answer is kept a moment (`FRESH_MS`), as every
// write asks the same things two or three times over, and forgotten at once when a write this server passes on may have
// changed them (`forgetRoster`). With no API set up at all (unit tests, a `nuxt dev` without its build), the store here
// answers, as before.
import type {BoardMember, Issue, Owner, Person, Project} from '#shared/roadmap'
import {actorId} from '../store/schema'
import {readFromApi} from './api-router'

const FRESH_MS = 2000

const kept = new Map<string, {at: number, value: Promise<unknown>}>()

/** The API's answer to `GET path`, kept `FRESH_MS`; one that failed isn't kept. With no API set up, `here` answers
 * instead, and isn't kept: the store is as fresh as it gets. */
async function remembered<T>(path: string, here: () => Promise<T>): Promise<T> {
    const now = Date.now()
    let found = kept.get(path)
    if (!found || now - found.at >= FRESH_MS) {
        const value = readFromApi<T>(path)
        kept.set(path, found = {at: now, value})
        value.catch(() => kept.delete(path))
    }
    const read = await found.value as T | undefined
    if (read !== undefined) return read
    kept.delete(path)
    return await here()
}

/** Forgets what's kept: a write to the owner, the people or a board's members may have changed it. */
export function forgetRoster() {
    kept.clear()
}

/** The owner: their id (`name`), their name as the page shows it, and whether they've given it. */
export function ownerNow(): Promise<Owner> {
    return remembered<Owner>('/api/owner', () => useStore().ownerOf())
}

/** Everyone, those removed included (`removed_at`). */
function people(): Promise<Pick<Person, 'id' | 'removed_at'>[]> {
    return remembered<Pick<Person, 'id' | 'removed_at'>[]>('/api/people', () => useStore().people())
}

/** Who's on `project`, its holder first; nobody on a project there isn't. */
function members(project: string): Promise<Pick<BoardMember, 'person' | 'role'>[]> {
    return remembered<Pick<BoardMember, 'person' | 'role'>[]>(`/api/projects/${encodeURIComponent(project)}/members`, () => useStore().members(project)).catch(error => {
        if ((error as {statusCode?: number}).statusCode === 404) return []
        throw error
    })
}

const present = async () => (await people()).filter(person => !person.removed_at)

/** Whether more than one person is here: only then do the rails between people hold. */
export async function isShared(): Promise<boolean> {
    return (await present()).length > 1
}

/** Whether `name` is a person here, by name or id, or stands for one (`owner`). */
export async function isPerson(name: string): Promise<boolean> {
    const id = actorId(name)
    return id === 'owner' || (await people()).some(person => person.id === id)
}

/** Whose a session is: with one person, theirs, whatever it says; with more, the person it names, by name or id.
 * Nobody when it names no one, or someone not (or no longer) here. */
export async function personFor(named: string | undefined): Promise<string | undefined> {
    const now = await present()
    if (now.length < 2) return (await ownerNow()).name
    const id = named && actorId(named)
    return now.find(person => person.id === id)?.id
}

/** Whether `person` may write on the board: with one person, anyone; else the owner, and those on it. */
export async function onBoard(project: string, person: string): Promise<boolean> {
    if (!await isShared() || person === (await ownerNow()).name) return true
    return (await members(project)).some(member => member.person === person)
}

/** Those of `projects` that `person` is on. */
export async function boardsOf(person: string, projects: string[]): Promise<string[]> {
    if (!await isShared() || person === (await ownerNow()).name) return projects
    const on = await Promise.all(projects.map(project => onBoard(project, person)))
    return projects.filter((_, i) => on[i])
}

/** Whether `person` holds the board. */
export async function holdsBoard(project: string, person: string): Promise<boolean> {
    return (await members(project)).some(member => member.person === person && member.role === 'owner')
}

/** The id of the project `named` names, by its id or its key (`GRE`), whatever the case; `named` itself when none does. */
export async function projectNamed(named: string): Promise<string> {
    const projects = await remembered<Pick<Project, 'id' | 'key'>[]>('/api/projects', () => useStore().listProjects())
    const asked = named.toLowerCase()
    return projects.find(project => project.id === named)?.id ?? projects.find(project => project.id.toLowerCase() === asked || project.key.toLowerCase() === asked)?.id ?? named
}

/** An issue as it is now, or null when there's none. Not kept: each check reads it again. */
export async function issueNow(project: string, issue: string): Promise<Pick<Issue, 'proposal' | 'labels'> | null> {
    try {
        return await readFromApi<Issue>(`/api/projects/${encodeURIComponent(project)}/issues/${encodeURIComponent(issue)}`) ?? await useStore().issue(project, issue)
    } catch {
        return null
    }
}
