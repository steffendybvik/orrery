// A project's releases, and the projects sharing them.
import type {Issue, ProjectReleases, Release} from '#shared/roadmap'
import {badRequest, checkInput, conflict} from '../utils/input'
import type {ProjectRow, ReleaseDetail, ReleaseRow} from './schema'
import {AGENT, RELEASE_FIELDS, releaseOf, tallyReleases, noReleases, nullable, stamp} from './schema'
import {DocStore} from './docs'
import {readReleaseBoard} from './reads'
import {known} from '#shared/known'

export abstract class ReleaseStore extends DocStore {
    async listReleases(project: string): Promise<Release[]> {
        return (await this.project(project)).releases
    }

    /** Every project with releases of its own, each with those it covers (ORR-671): a release several projects share
     * is listed once, under the project it's made on, with each project's part. */
    async allReleases(): Promise<ProjectReleases[]> {
        const statuses = await this.statuses()
        const shipping = await this.all<Pick<ProjectRow, 'id' | 'release_mode' | 'releases_from'>>("SELECT id, release_mode, releases_from FROM projects WHERE release_mode <> 'none' ORDER BY id")
        return await Promise.all(shipping.filter(p => p.release_mode === 'own').map(async ({id}) => {
            const projects = [id, ...shipping.filter(p => p.releases_from === id).map(p => p.id)]
            const rows = await this.all<ReleaseRow>('SELECT * FROM releases WHERE project = ? ORDER BY position, created_at DESC', id)
            const versions = rows.map(row => row.version)
            const boards = await Promise.all(projects.map(project => readReleaseBoard(this.db, project, statuses)))
            const together = tallyReleases(versions, boards)
            const parts = boards.map(board => tallyReleases(versions, [board]))
            return {
                project: id,
                projects,
                releases: rows.map(row => {
                    const {notes: _, ...release} = releaseOf(row)
                    return {
                        ...release,
                        ...known(together.get(row.version), `a tally for ${row.version}`),
                        projects: projects.map((project, at) => ({project, ...known(parts[at]?.get(row.version), `${project}'s tally for ${row.version}`)})),
                    }
                }),
            }
        }))
    }

    /** The release with its issues: those set for it (a sub-issue's when its parent isn't), each with its sub-issues,
     * as `tasks` (the project's own) and by project in `projects` (with those drawing on it, when it's their source). */
    async release(project: string, version: string): Promise<ReleaseDetail> {
        await this.releaseRow(project, version)
        const own = await this.project(project)
        const drawing = own.releases_from ? [] : await Promise.all((await this.drawingOn(project)).map(id => this.project(id)))
        const part = (p: typeof own) => {
            const tasks: Issue[] = []
            const walk = (issues: Issue[]) => issues.forEach(issue => issue.release === version ? tasks.push(issue) : walk(issue.tasks))
            p.board.chunks.forEach(c => walk(c.tasks))
            const {issues, kinds} = known(p.releases.find(r => r.version === version), `release ${version} in ${p.id}`)
            return {project: p.id, name: p.name, issues, kinds, tasks}
        }
        // A source's own row counts every project; its part here is only its own issues.
        const mine = drawing.length ? {...part(own), ...known(tallyReleases([version], [own.board]).get(version), `a tally for ${version}`)} : part(own)
        return {...known(own.releases.find(r => r.version === version), `release ${version}`), project, tasks: mine.tasks, projects: [mine, ...drawing.map(part)]}
    }

    /** The newest doc revision on this orrery, 0 with none yet: revision ids run across its projects, so it holds for a shared release too. */
    private async docMark(): Promise<number> {
        return (await this.one<{n: number | null}>('SELECT max(id) AS n FROM doc_revisions')).n ?? 0
    }

    /** Refuses changing a release from a project that takes its releases from another. */
    protected async ownReleases(project: string, action: string) {
        const source = await this.releaseSource(project)
        if (!source) throw badRequest(noReleases(project))
        if (source !== project) throw badRequest(`${project} takes its releases from ${source}; ${action} there: /api/projects/${source}/releases`)
    }

    async createRelease(project: string, body: unknown, actor = AGENT): Promise<ReleaseDetail> {
        await this.ownReleases(project, 'make them')
        const input = checkInput(body, RELEASE_FIELDS)
        const version = String(input.version)
        if (await this.get('SELECT 1 FROM releases WHERE project = ? AND version = ?', project, version)) throw conflict(`There is already a release ${version} in ${project}`)
        const now = stamp()
        await this.db.transaction(async () => {
            const top = (await this.get<{n: number | null}>('SELECT min(position) AS n FROM releases WHERE project = ?', project))?.n ?? 0
            await this.run('INSERT INTO releases (project, version, branch, notes, frozen_on, shipped_on, doc_mark, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, version, nullable(input.branch)?.trim() || null, nullable(input.notes), nullable(input.frozen_on), nullable(input.shipped_on), input.shipped_on ? await this.docMark() : null, top - 1, actor.name, Number(actor.owner), now, now)
            if (input.position !== undefined) await this.placeRelease(project, version, Number(input.position))
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('release.created', project, version, actor)
        return await this.release(project, version)
    }

    async updateRelease(project: string, version: string, body: unknown, actor = AGENT): Promise<ReleaseDetail> {
        await this.ownReleases(project, 'change them')
        const before = await this.releaseRow(project, version)
        const input = checkInput(body, RELEASE_FIELDS, true)
        if (input.version !== undefined && input.version !== version) throw badRequest("A release's version can't change: make one with the new version and move its issues to it")
        await this.db.transaction(async () => {
            await this.update('releases', 'project = ? AND version = ?', [project, version], {
                branch: input.branch === undefined ? undefined : String(input.branch ?? '').trim() || null,
                notes: input.notes,
                frozen_on: input.frozen_on,
                shipped_on: input.shipped_on,
                // Shipping marks the docs as they are now, and shipping it again marks them anew: un-shipping lets go of the
                // old mark, as what ships next isn't what shipped then. A new day on one already shipped keeps it.
                doc_mark: input.shipped_on === undefined || !!input.shipped_on === !!before.shipped_on ? undefined : input.shipped_on ? await this.docMark() : null,
            })
            if (input.position !== undefined) await this.placeRelease(project, version, Number(input.position))
            await this.touchProject(project)
        })
        this.changed(project)
        // Frozen or shipped as the day is set, thawed or unshipped as it's cleared; a new day on one already set is no event.
        for (const [field, on, off] of [['frozen_on', 'frozen', 'thawed'], ['shipped_on', 'shipped', 'unshipped']] as const) {
            if (input[field] === undefined || !!input[field] === !!before[field]) continue
            this.tell(`release.${input[field] ? on : off}`, project, version, actor)
        }
        return await this.release(project, version)
    }

    /** Checks a release as making it (no `version`) or changing release `version` would, saving nothing: the release as
     * it is, when it's a change. The owner's chat asks before it makes or changes one (ORR-504). */
    async checkRelease(project: string, body: unknown, version?: string): Promise<Release | undefined> {
        await this.ownReleases(project, version === undefined ? 'make them' : 'change them')
        const input = checkInput(body, RELEASE_FIELDS, version !== undefined)
        if (version === undefined) {
            if (await this.get('SELECT 1 FROM releases WHERE project = ? AND version = ?', project, String(input.version))) throw conflict(`There is already a release ${String(input.version)} in ${project}`)
            return undefined
        }
        await this.releaseRow(project, version)
        if (input.version !== undefined && input.version !== version) throw badRequest("A release's version can't change: make one with the new version and move its issues to it")
        return (await this.listReleases(project)).find(r => r.version === version)
    }

    /** Puts the release at `index` among the project's releases (0 the top, past the end the bottom), numbering
     * them all again from 0. */
    protected async placeRelease(project: string, version: string, index: number) {
        const others = (await this.all<{version: string}>('SELECT version FROM releases WHERE project = ? ORDER BY position, created_at DESC', project))
            .map(r => r.version).filter(v => v !== version)
        others.splice(Math.max(0, Math.min(Math.trunc(index), others.length)), 0, version)
        for (const [position, each] of others.entries()) await this.run('UPDATE releases SET position = ? WHERE project = ? AND version = ?', position, project, each)
    }

    /** Its issues stay, set for no release, in every project drawing on it too. */
    async deleteRelease(project: string, version: string, actor = AGENT) {
        await this.ownReleases(project, 'delete them')
        const row = await this.releaseRow(project, version)
        this.refuse(actor, `Deleting release ${version}`, row.owned ? [`release ${version}`] : [])
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET ships_in = NULL WHERE (project = ? OR project IN (SELECT id FROM projects WHERE releases_from = ?)) AND ships_in = ?', project, project, version)
            await this.run('DELETE FROM releases WHERE project = ? AND version = ?', project, version)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('release.deleted', project, version, actor)
    }
}
