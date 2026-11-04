// Milestones: a project's roadmap, in order.
import type {Issue} from '#shared/roadmap'
import {fullId} from '#shared/roadmap'
import {checkInput} from '../utils/input'
import type {MilestoneRecord, MilestoneRow} from './schema'
import {AGENT, MILESTONE_FIELDS, nullable, stamp} from './schema'
import {PresetStore} from './presets'
import {known} from '#shared/known'
import {milestoneRecord} from './reads'

export abstract class MilestoneStore extends PresetStore {
    async listMilestones(project: string): Promise<MilestoneRecord[]> {
        const {board} = await this.project(project)
        return (await this.all<MilestoneRow>('SELECT * FROM milestones WHERE project = ? ORDER BY position, created_at', project))
            .map(row => milestoneRecord(row, known(board.milestones.find(c => c.id === row.id), `milestone ${row.id} on the board`)))
    }

    async milestone(project: string, id: string): Promise<MilestoneRecord & {tasks: Issue[]}> {
        id = await this.milestoneId(project, id)
        const row = await this.milestoneRow(project, id)
        const view = known((await this.project(project)).board.milestones.find(c => c.id === id), `milestone ${id} on the board`)
        return {...milestoneRecord(row, view), tasks: view.tasks, full_id: fullId('milestone', view.id, (await this.projectRow(project)).uid)}
    }

    async createMilestone(project: string, body: unknown, actor = AGENT): Promise<MilestoneRecord & {tasks: Issue[]}> {
        await this.projectRow(project)
        const input = checkInput(body, MILESTONE_FIELDS)
        const title = String(input.title).trim()
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'milestone')
            await this.run('INSERT INTO milestones (project, id, title, summary, priority, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, nullable(input.summary), nullable(input.priority), Number(input.position ?? await this.nextPosition('milestones', project)), actor.name, Number(actor.owner), now, now)
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        this.tell('milestone.created', project, id, actor)
        return await this.milestone(project, id)
    }

    async updateMilestone(project: string, id: string, body: unknown): Promise<MilestoneRecord & {tasks: Issue[]}> {
        id = await this.milestoneId(project, id)
        await this.milestoneRow(project, id)
        const input = checkInput(body, MILESTONE_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update('milestones', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                summary: input.summary,
                priority: input.priority,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.milestone(project, id)
    }

    /** Its issues stay, in no milestone. */
    async deleteMilestone(project: string, id: string, actor = AGENT) {
        id = await this.milestoneId(project, id)
        const row = await this.milestoneRow(project, id)
        this.refuse(actor, `Deleting milestone "${id}"`, row.owned ? [`milestone "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET milestone = NULL WHERE project = ? AND milestone = ?', project, id)
            await this.run('DELETE FROM milestone_aliases WHERE project = ? AND milestone = ?', project, id)
            await this.run('DELETE FROM signals WHERE project = ? AND milestone = ?', project, id)
            // Schedules that made issues in it make them in no milestone from now on.
            await this.run('UPDATE schedules SET milestone = NULL WHERE project = ? AND milestone = ?', project, id)
            await this.run('DELETE FROM milestones WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }
}
