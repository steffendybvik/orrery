// Importing a roadmap file into a project.
import type {Project} from '#shared/roadmap'
import {conflict} from '../utils/input'
import type {RoadmapFile, TaskFile} from '../utils/roadmap'
import {legacyStatus} from '../utils/roadmap'
import {renumber} from '../utils/renumber'
import {AGENT, stamp} from './schema'
import {BulkStore} from './bulk'

export abstract class ImportStore extends BulkStore {
    /** Loads a roadmap in `docs/roadmap.json`'s format; `replace` first clears the project's milestones and issues.
     * Everything gets the project's ids (milestones 1, 2, …, issues KEY-1, …), the file's ids becoming aliases. */
    async importRoadmap(project: string, roadmap: RoadmapFile, replace = false, actor = AGENT): Promise<Project> {
        await this.projectRow(project)
        if (await this.railsFor(actor)) throw conflict(`With more than one person on this orrery, only a person imports a roadmap`)
        if (replace) this.refuse(actor, `Replacing ${project}'s roadmap`, (await this.ownedIn(project)).filter(what => !what.startsWith('project ') && !what.startsWith('doc ')))
        const has = await this.get('SELECT 1 FROM issues WHERE project = ? UNION SELECT 1 FROM milestones WHERE project = ?', project, project)
        if (has && !replace) throw conflict(`${project} already has milestones or issues; import with ?replace=true to replace them`)

        const now = stamp()
        let position = 0
        const insert = async (task: TaskFile, parent: string | null, milestone: string | null) => {
            await this.run(`INSERT INTO issues (project, id, title, status, priority, assignee, labels, notes, parent, milestone, position,
                                          created_by, owned, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                project, task.id, task.title, await this.resolveStatus(legacyStatus(task.status, task.plan)), task.priority ?? null, task.assignee ?? null, JSON.stringify(task.labels),
                task.notes ?? null, parent, milestone, position++, actor.name, Number(actor.owner), now, now)
            for (const sub of task.tasks) await insert(sub, task.id, null)
        }
        await this.db.transaction(async () => {
            await this.db.deferConstraints()
            if (replace) {
                // Nothing keeps pointing at what's replaced, where an id from the file could take its place.
                const gone = await this.all<{id: string}>('SELECT id FROM issues WHERE project = ?', project)
                await this.issuesMoved(project, new Map(gone.map(({id}) => [id, null])))
                await this.run('DELETE FROM signals WHERE project = ? AND milestone IS NOT NULL', project)
                await this.run('UPDATE schedules SET milestone = NULL WHERE project = ?', project)
                await this.run('DELETE FROM comments WHERE project = ?', project)
                await this.run('UPDATE issues SET parent = NULL, milestone = NULL WHERE project = ?', project)
                await this.run('DELETE FROM issues WHERE project = ?', project)
                await this.run('DELETE FROM milestones WHERE project = ?', project)
                await this.run('DELETE FROM issue_aliases WHERE project = ?', project)
                await this.run('DELETE FROM issue_links WHERE project = ? OR on_project = ?', project, project)
                await this.run('DELETE FROM milestone_aliases WHERE project = ?', project)
            }
            for (const [i, milestone] of roadmap.milestones.entries()) {
                await this.run('INSERT INTO milestones (project, id, title, summary, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    project, milestone.id, milestone.title, milestone.summary || null, i, actor.name, Number(actor.owner), now, now)
                for (const task of milestone.tasks) await insert(task, null, milestone.id)
            }
            await renumber(this.db, project)
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.project(project)
    }
}
