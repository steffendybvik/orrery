// The people on this orrery (ORR-653): the owner, who has a row as soon as they're named, and the members they add. An
// agent is a session, with no record of its own: `personFor` says whose it is. Below the projects, as a person
// removed lets go of their open issues.
import {CLOSED} from '#shared/roadmap'
import type {BoardMember, Person} from '#shared/roadmap'
import type {Actor} from './schema'
import {AGENT, MEMBER_FIELDS, OWNER_FIELDS, actorId, stamp} from './schema'
import {badRequest, checkInput, conflict, notFound} from '../utils/input'
import {refusedFor} from '../utils/permission'
import {OwnerStore} from './owner'

/** What agents and orrery send or stand for: as a person's id, each would make them all that person. */
const RESERVED = ['owner', AGENT.name, 'claude', 'orrery']

type PersonRow = {id: string, name: string, role: Person['role'], created_at: string, removed_at: string | null}
const personOf = ({id, name, role, created_at, removed_at}: PersonRow): Person => ({id, name, role, created_at, ...removed_at ? {removed_at} : {}})

export abstract class PeopleStore extends OwnerStore {
    /** Everyone, the owner first, then in the order they were added; those removed stay listed, with `removed_at`. */
    async people(): Promise<Person[]> {
        return (await this.all<PersonRow>("SELECT * FROM people ORDER BY role = 'owner' DESC, created_at, id")).map(personOf)
    }

    /** Adds a person. Their id comes from the name as the owner's does, and never changes. One a removed person had
     * stays theirs, so history can't come to mean someone else. */
    async addPerson(body: unknown): Promise<Person> {
        if (!(await this.ownerOf()).named) throw badRequest('Give your own name first (PUT /api/owner): you are the first person')
        const name = this.personName(body)
        const id = actorId(name)
        if (!id) throw badRequest('The name needs a letter or a digit in it')
        if (RESERVED.includes(id)) throw badRequest(`"${id}" is what agents or orrery go by; pick another name`)
        const taken = await this.get<PersonRow>('SELECT * FROM people WHERE id = ?', id)
        if (taken) throw conflict(`"${id}" ${taken.removed_at ? 'was someone who has been removed' : `is ${taken.name}`}; pick another name`)
        await this.run("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'member', ?)", id, name, stamp())
        return await this.person(id)
    }

    /** Renames a member. Only the name changes, as their id stays what history holds. The owner's own goes through `nameOwner`. */
    async renamePerson(id: string, body: unknown): Promise<Person> {
        const person = await this.person(id)
        if (person.role === 'owner') throw badRequest("The owner's name is changed with PUT /api/owner")
        if (person.removed_at) throw conflict(`${person.name} has been removed`)
        await this.run('UPDATE people SET name = ? WHERE id = ?', this.personName(body), person.id)
        return await this.person(person.id)
    }

    /** Removes a member: their name stays on history, their open issues go back to unassigned, each with an activity
     * line, and their sessions can no longer claim (`personFor` no longer knows them). */
    async removePerson(id: string, actor: Actor): Promise<void> {
        const person = await this.person(id)
        if (person.role === 'owner') throw badRequest('The owner can\'t be removed')
        if (person.removed_at) return
        const closed = (await this.statuses()).filter(s => CLOSED.includes(s.kind)).map(s => s.id)
        const open = await this.all<{project: string, id: string, assignee: string}>(
            `SELECT project, id, assignee FROM issues WHERE lower(assignee) = ?${closed.length ? ` AND status NOT IN (${closed.map(() => '?').join(', ')})` : ''}`, person.id, ...closed)
        const {name: owner} = await this.ownerOf()
        await this.db.transaction(async () => {
            await this.run('UPDATE people SET removed_at = ? WHERE id = ?', stamp(), person.id)
            // What they held goes to the owner, who may already be on it.
            await this.run("DELETE FROM project_members WHERE person = ? AND role = 'member'", person.id)
            await this.run("DELETE FROM project_members WHERE person = ? AND project IN (SELECT project FROM project_members WHERE person = ?)", owner, person.id)
            await this.run('UPDATE project_members SET person = ? WHERE person = ?', owner, person.id)
            for (const issue of open) {
                await this.update('issues', 'project = ? AND id = ?', [issue.project, issue.id], {assignee: null})
                await this.record(issue.project, issue.id, actor, [['assignee', issue.assignee, null]])
            }
        })
        for (const project of new Set(open.map(issue => issue.project))) this.changed(project)
    }

    /** Whose a session is: with one person, theirs, whatever it says, so older channels keep working; with more, the
     * person it names, by name or id. Nobody when it names no one, or someone not (or no longer) here. */
    async personFor(named: string | undefined): Promise<string | undefined> {
        const here = await this.all<{id: string}>('SELECT id FROM people WHERE removed_at IS NULL')
        if (here.length < 2) return (await this.ownerOf()).name
        const id = named && actorId(named)
        return here.find(person => person.id === id)?.id
    }

    /** Whether `person` may write on the board: with one person, anyone; else the owner, and those on it. */
    async onBoard(project: string, person: string): Promise<boolean> {
        if (!await this.shared() || person === (await this.ownerOf()).name) return true
        return !!await this.get('SELECT 1 FROM project_members WHERE project = ? AND person = ?', project, person)
    }

    /** Those of `projects` that `person` is on. */
    async boardsOf(person: string, projects: string[]): Promise<string[]> {
        if (!await this.shared() || person === (await this.ownerOf()).name) return projects
        const on = new Set((await this.all<{project: string}>('SELECT project FROM project_members WHERE person = ?', person)).map(row => row.project))
        return projects.filter(project => on.has(project))
    }

    /** Whether `person` holds the board. */
    async holdsBoard(project: string, person: string): Promise<boolean> {
        return !!await this.get("SELECT 1 FROM project_members WHERE project = ? AND person = ? AND role = 'owner'", project, person)
    }

    /** Who's on the board, its holder first, then in the order they joined. */
    async members(project: string): Promise<BoardMember[]> {
        await this.projectRow(project)
        return await this.all<BoardMember>(`SELECT m.person, p.name, m.role, m.created_at FROM project_members m JOIN people p ON p.id = m.person
            WHERE m.project = ? ORDER BY m.role = 'owner' DESC, m.created_at, m.person`, project)
    }

    /** Puts a person on the board: its holder's to do, or the owner's, and never an agent's. */
    async addMember(project: string, body: unknown, actor = AGENT): Promise<BoardMember> {
        await this.projectRow(project)
        await this.managesBoard(project, actor)
        const person = await this.person(actorId(String(checkInput(body, MEMBER_FIELDS).person)))
        if (person.removed_at) throw conflict(`${person.name} has been removed`)
        await this.run("INSERT INTO project_members (project, person, role, created_at) VALUES (?, ?, 'member', ?) ON CONFLICT (project, person) DO NOTHING", project, person.id, stamp())
        this.changed(project)
        const added = (await this.members(project)).find(member => member.person === person.id)
        if (!added) throw notFound(`${person.name} isn't on ${project}`)
        return added
    }

    /** Takes a person off the board. Its holder stays: a board always has one. */
    async removeMember(project: string, person: string, actor = AGENT): Promise<void> {
        await this.projectRow(project)
        await this.managesBoard(project, actor)
        if (await this.holdsBoard(project, person)) throw badRequest(`${person} holds ${project}, so they stay on it`)
        await this.run('DELETE FROM project_members WHERE project = ? AND person = ?', project, person)
        this.changed(project)
    }

    private async managesBoard(project: string, actor: Actor) {
        if (!actor.owner && !await this.holdsBoard(project, actorId(actor.name))) {
            throw refusedFor('members.write', `Only ${project}'s holder or the owner says who's on it, and an agent never does (members.write)`)
        }
    }

    /** `shared`, for what orrery does outside the store. */
    async isShared(): Promise<boolean> {
        return await this.shared()
    }

    /** Whether more than one person is here: only then do the rails between people hold. */
    protected async shared(): Promise<boolean> {
        return (await this.one<{n: number}>('SELECT count(*) AS n FROM people WHERE removed_at IS NULL')).n > 1
    }

    /** The person an issue is assigned to: `claude` counts as the owner's, and an assignee who isn't a person is nobody. */
    protected async holderOf(assignee: string | null | undefined): Promise<string | null> {
        const id = assignee?.toLowerCase()
        if (!id) return null
        if (id === 'claude') return await this.ownerId()
        return await this.get('SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL', id) ? id : null
    }

    private async person(id: string): Promise<Person> {
        const row = await this.get<PersonRow>('SELECT * FROM people WHERE id = ?', id)
        if (!row) throw notFound(`No person "${id}"`)
        return personOf(row)
    }

    private personName(body: unknown): string {
        const name = String(checkInput(body, OWNER_FIELDS).name).trim().slice(0, 60)
        if (!name) throw badRequest('The name needs a letter or a digit in it')
        return name
    }
}
