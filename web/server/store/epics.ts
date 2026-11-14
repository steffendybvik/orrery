// Epics (ORR-895): one piece of work across projects. An epic holds issues from any project, has a number of its own
// across the orrery, and its progress is its issues', counted the way a release's are. An issue is in one at most
// (`epic`), and a sub-issue with none goes with its parent's.
import type {Epic, EpicDetail, Issue} from '#shared/roadmap'
import {emptyKinds, fullId, numberOf} from '#shared/roadmap'
import {checkInput, notFound} from '../utils/input'
import {refusedFor} from '../utils/permission'
import type {EpicRow} from './schema'
import {AGENT, EPIC_FIELDS, nullable, stamp, tallyEpics} from './schema'
import {ReleaseStore} from './releases'
import {readReleaseBoard} from './reads'
import {known} from '#shared/known'

export abstract class EpicStore extends ReleaseStore {
    /** Tells open pages the epics changed (`/api/events`' `epics`), so they ask for them again. */
    epicsChanged: () => void = () => {}

    /** Open pages ask for the epics again, and the outbox says they changed (ORR-1004). */
    protected sayEpics() {
        this.outbox('epics')
        this.epicsChanged()
    }

    /** The epic from its number or any form of its id (ORR-995): `1`, `EPC-1`, or `EPC-1-x7k2m9qd` in full. */
    protected async epicRow(sent: number | string): Promise<EpicRow> {
        const id = Number(numberOf('epic', sent, (await this.settings()).uid))
        const row = Number.isInteger(id) && String(sent).trim() !== '' ? await this.get<EpicRow>('SELECT * FROM epics WHERE id = ?', id) : undefined
        if (!row) throw notFound(`No epic ${sent}: GET /api/epics lists them`)
        return row
    }

    /** The projects with an issue set for one of `epics` (every epic, without), by id. */
    private async projectsIn(epics?: number[]): Promise<string[]> {
        const rows = epics
            ? await this.all<{project: string}>(`SELECT DISTINCT project FROM issues WHERE epic IN (${epics.map(() => '?').join(', ') || 'NULL'}) ORDER BY project`, ...epics)
            : await this.all<{project: string}>('SELECT DISTINCT project FROM issues WHERE epic IS NOT NULL ORDER BY project')
        return rows.map(r => r.project)
    }

    /** Every epic, in the order they're arranged in, a new one on top, each with its progress and each project's part. */
    async epics(): Promise<Epic[]> {
        const read = await this.fromApi<Epic[]>('/api/epics')
        if (read) return read
        const rows = await this.all<EpicRow>('SELECT * FROM epics ORDER BY position, id DESC')
        const ids = rows.map(r => r.id)
        const statuses = await this.statuses()
        const projects = await this.projectsIn()
        const boards = await Promise.all(projects.map(project => readReleaseBoard(this.db, project, statuses)))
        const together = tallyEpics(ids, boards)
        const parts = boards.map(board => tallyEpics(ids, [board]))
        const {uid} = await this.settings()
        return rows.map(row => {
            const {issues, kinds} = together.get(row.id) ?? {issues: 0, kinds: emptyKinds()}
            return {
                ...epicOf(row), full_id: fullId('epic', row.id, uid), issues, kinds,
                projects: projects.flatMap((project, at) => {
                    const part = parts[at]?.get(row.id)
                    return part && part.issues ? [{project, ...part}] : []
                }),
            }
        })
    }

    /** The epic with its issues, in a section per project: those set for it (a sub-issue's when its parent isn't), each
     * with its sub-issues. */
    async epic(id: number): Promise<EpicDetail> {
        const row = await this.epicRow(id)
        const epic = known((await this.epics()).find(e => e.id === row.id), `epic ${row.id}`)
        const parts = await Promise.all((await this.projectsIn([row.id])).map(async project => {
            const p = await this.project(project)
            const tasks: Issue[] = []
            const walk = (issues: Issue[]) => issues.forEach(issue => issue.epic === row.id ? tasks.push(issue) : walk(issue.tasks))
            p.board.milestones.forEach(m => walk(m.tasks))
            const part = epic.projects.find(e => e.project === project)
            return part ? [{project, name: p.name, issues: part.issues, kinds: part.kinds, tasks}] : []
        }))
        return {...epic, parts: parts.flat()}
    }

    /** A new epic, `{title, notes?, position?}`, on top unless `position` says where. */
    async createEpic(body: unknown, actor = AGENT): Promise<EpicDetail> {
        const input = checkInput(body, EPIC_FIELDS)
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const top = (await this.get<{n: number | null}>('SELECT min(position) AS n FROM epics'))?.n ?? 0
            const row = await this.one<{id: number}>('INSERT INTO epics (title, notes, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
                String(input.title).trim(), nullable(input.notes), top - 1, actor.name, Number(actor.owner), now, now)
            const id = Number(row.id)
            if (input.position !== undefined) await this.placeEpic(id, Number(input.position))
            return id
        })
        this.sayEpics()
        return await this.epic(id)
    }

    /** Its title or notes changed is `epic.changed` on each project with an issue in it (ORR-984), so the sessions on
     * them hear it; moving it among the epics says nothing. */
    async updateEpic(id: number, body: unknown, actor = AGENT): Promise<EpicDetail> {
        const before = await this.epicRow(id)
        const input = checkInput(body, EPIC_FIELDS, true)
        const title = input.title === undefined ? undefined : String(input.title).trim()
        const reworded = (title !== undefined && title !== before.title) || (input.notes !== undefined && (input.notes ?? null) !== (before.notes ?? null))
        const projects = reworded ? await this.projectsIn([id]) : []
        await this.db.transaction(async () => {
            await this.update('epics', 'id = ?', [id], {title, notes: input.notes})
            if (input.position !== undefined) await this.placeEpic(id, Number(input.position))
            for (const project of projects) this.tell('epic.changed', project, String(id), actor)
        })
        this.sayEpics()
        return await this.epic(id)
    }

    /** Puts the epic at `index` among them (0 the top, past the end the bottom), numbering them all again from 0. */
    private async placeEpic(id: number, index: number) {
        const others = (await this.all<{id: number}>('SELECT id FROM epics ORDER BY position, id DESC')).map(r => Number(r.id)).filter(e => e !== id)
        others.splice(Math.max(0, Math.min(Math.trunc(index), others.length)), 0, id)
        for (const [position, each] of others.entries()) await this.run('UPDATE epics SET position = ? WHERE id = ?', position, each)
    }

    /** Its issues stay where they are, in no epic, each told as `issue.epic` (ORR-984). The owner's own epic is theirs
     * to delete. */
    async deleteEpic(id: number, actor = AGENT) {
        const row = await this.epicRow(id)
        if (row.owned && !actor.owner) throw refusedFor('epics.delete', `Deleting epic ${id} is the owner's call: they made it`)
        const projects = await this.projectsIn([id])
        const issues = await this.all<{project: string, id: string}>('SELECT project, id FROM issues WHERE epic = ? ORDER BY project, id', id)
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET epic = NULL WHERE epic = ?', id)
            for (const issue of issues) this.tell('issue.epic', issue.project, issue.id, actor, {from: String(id), to: null})
            await this.run('DELETE FROM epics WHERE id = ?', id)
            for (const project of projects) await this.touchProject(project)
        })
        for (const project of projects) this.changed(project)
        this.sayEpics()
    }
}

export function epicOf(row: EpicRow): Omit<Epic, 'issues' | 'kinds' | 'projects'> {
    return {
        id: Number(row.id), title: row.title, ...row.notes ? {notes: row.notes} : {},
        created_by: row.created_by, protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}
