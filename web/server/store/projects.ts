// Projects: making, changing and deleting them, their prompts and where their releases come from.
import type {Project, ReleaseMode, Starts} from '#shared/roadmap'
import {keyFor, slugify} from '#shared/roadmap'
import type {Input} from '../utils/input'
import {badRequest, checkInput, conflict} from '../utils/input'
import type {Instruction} from '#shared/prompt'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT, defaultInstructions} from '#shared/prompt'
import type {ProjectSummary, Actor, ProjectRow} from './schema'
import {AGENT, SLUG, PROJECT_FIELDS, PROMPT_FIELDS, releaseModeOf, nullable, stamp} from './schema'
import {PeopleStore} from './people'
import {refusedFor} from '../utils/permission'

export abstract class ProjectStore extends PeopleStore {
    async listProjects(): Promise<ProjectSummary[]> {
        return Promise.all((await this.all<ProjectRow>('SELECT * FROM projects ORDER BY lower(name), name')).map(async row => {
            const {board, ...project} = await this.projectOf(row)
            return {...project, counts: board.counts, kinds: board.kinds, chunks: board.chunks.filter(c => c.id).length}
        }))
    }

    async listBoards(): Promise<Project[]> {
        return Promise.all((await this.all<ProjectRow>('SELECT * FROM projects ORDER BY lower(name), name')).map(row => this.projectOf(row)))
    }

    async project(id: string): Promise<Project> {
        return await this.projectOf(await this.projectRow(id))
    }

    /** The project's id, or a 404 when there's none, without building its board. */
    async projectId(id: string): Promise<string> {
        return (await this.projectRow(id)).id
    }

    async createProject(body: unknown, actor = AGENT): Promise<Project> {
        const input = checkInput(body, PROJECT_FIELDS)
        this.promptsAreTheOwners(input, actor)
        const name = String(input.name).trim()
        const id = input.id ? String(input.id) : slugify(name)
        if (!SLUG.test(id)) throw badRequest(`"${name}" doesn't make an id; give one in "id"`)
        if (await this.get('SELECT 1 FROM projects WHERE id = ?', id)) throw conflict(`There is already a project "${id}"`)
        const key = input.key ? String(input.key) : keyFor(name)
        const {mode, from} = releaseModeOf(input, 'none', null)
        if (from) await this.checkReleasesFrom(id, from)
        const now = stamp()
        await this.run('INSERT INTO projects (id, name, key, description, icon, icon_color, repo, release_mode, releases_from, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id, name, key, nullable(input.description), nullable(input.icon), nullable(input.icon_color), nullable(input.repo), mode, from, actor.name, Number(actor.owner), now, now)
        await this.update('projects', 'id = ?', [id], this.promptColumns(input))
        this.changed(id)
        return await this.project(id)
    }

    async updateProject(id: string, body: unknown, actor = AGENT): Promise<Project> {
        const row = await this.projectRow(id)
        const input = checkInput(body, PROJECT_FIELDS, true)
        this.promptsAreTheOwners(input, actor)
        if (input.id !== undefined && input.id !== id) throw badRequest("A project's id can't change")
        const {mode, from} = releaseModeOf(input, row.release_mode, row.releases_from)
        const before = row.releases_from
        if (mode !== row.release_mode || from !== before) await this.checkReleaseMode(row, mode, from)
        await this.db.transaction(async () => {
            await this.update('projects', 'id = ?', [id], {
                name: input.name === undefined ? undefined : String(input.name).trim(),
                key: input.key,
                description: input.description,
                icon: input.icon,
                icon_color: input.icon_color,
                repo: input.repo,
                release_mode: mode,
                releases_from: from,
                ...this.promptColumns(input),
            })
            // Its issues keep only the releases the new source has: none without releases, or back on its own (it has none yet).
            if (mode !== row.release_mode || from !== before) {
                const source = mode === 'shared' ? from : mode === 'own' ? id : null
                if (source) await this.run('UPDATE issues SET ships_in = NULL WHERE project = ? AND ships_in IS NOT NULL AND ships_in NOT IN (SELECT version FROM releases WHERE project = ?)', id, source)
                else await this.run('UPDATE issues SET ships_in = NULL WHERE project = ?', id)
            }
        })
        this.changed(id)
        // The old source counted its issues, and the new one does now.
        if (before && before !== from) this.changed(before)
        return await this.project(id)
    }

    /** Whether the project can leave its own releases (for none, or another's): nothing of its own to lose or
     * merge, and nobody drawing on them; and when it takes another's, that they can be taken. */
    protected async checkReleaseMode(row: ProjectRow, mode: ReleaseMode, from: string | null) {
        if (row.release_mode === 'own' && mode !== 'own') {
            const drawing = await this.drawingOn(row.id)
            if (drawing.length) throw conflict(`${drawing.join(', ')} ${drawing.length === 1 ? 'takes its' : 'take their'} releases from ${row.id}, so it keeps its own`)
            const own = await this.all<{version: string}>('SELECT version FROM releases WHERE project = ? ORDER BY version', row.id)
            if (own.length) throw conflict(`${row.id} has releases of its own (${own.map(r => r.version).join(', ')}); delete them first, ${mode === 'shared' ? `nothing merges into ${from}'s` : 'nothing goes quietly'}`)
        }
        if (from) await this.checkReleasesFrom(row.id, from)
    }

    /** Whether `id` can take its releases from `from`: another project with releases of its own, one level only. */
    protected async checkReleasesFrom(id: string, from: string) {
        if (from === id) throw badRequest("A project can't take its releases from itself; send release_mode \"own\" to give it its own")
        const source = await this.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', from)
        if (!source) throw badRequest(`No project "${from}" to take releases from`)
        if (source.release_mode === 'shared') throw badRequest(`${from} takes its releases from ${source.releases_from}; take them from ${source.releases_from} too`)
        if (source.release_mode === 'none') throw badRequest(`${from} has no releases; give it its own first (release_mode "own")`)
    }

    protected promptsAreTheOwners(input: Input, actor: Actor) {
        const sent = PROMPT_FIELDS.filter(key => input[key] !== undefined)
        if (sent.length && !actor.owner) throw refusedFor('prompts.write', `Only the owner changes what sessions are told (${sent.join(', ')}); send Orrery-Actor: <owner>`)
    }

    /** The prompt fields as columns: an empty template is none (the orrery's). */
    protected promptColumns(input: Input): Input {
        const template = (value: Input[string]) => value === undefined ? undefined : String(value ?? '').trim() || null
        const list = (value: Input[string]) => value === undefined ? undefined : JSON.stringify(value ?? [])
        return {
            focus_prompt: template(input.focus_prompt), chunk_prompt: template(input.chunk_prompt), instructions: list(input.instructions), muted: list(input.muted),
        }
    }

    /** Whether orrery may start sessions for the project, and within what: the orrery's, as the owner lets it start
     * them for every project at once; none while they haven't. */
    async starts(project: string): Promise<Starts | undefined> {
        await this.projectRow(project)
        return await this.orreryStarts()
    }

    /** The templates the project's sessions hear: its own, else the orrery's, else the defaults. */
    async prompts(project: string): Promise<{focus: string, chunk: string}> {
        const row = await this.projectRow(project)
        const settings = await this.settings()
        return {
            focus: row.focus_prompt ?? settings.focus_prompt ?? DEFAULT_FOCUS_PROMPT,
            chunk: row.chunk_prompt ?? settings.chunk_prompt ?? DEFAULT_CHUNK_PROMPT,
        }
    }

    /** The texts of the standing instructions for a focus: those named by id, or else the ones ticked by default. */
    protected async instructionsFor(project: string, ids: Input[string]): Promise<string[]> {
        const row = await this.projectRow(project)
        const global = (await this.settings()).instructions
        const own = JSON.parse(row.instructions) as Instruction[]
        if (ids === undefined || ids === null) return defaultInstructions(global, own, JSON.parse(row.muted) as string[]).map(i => i.text)
        const all = [...global, ...own]
        const unknown = (ids as string[]).filter(id => !all.some(i => i.id === id))
        if (unknown.length) throw badRequest(`No standing instruction ${unknown.join(', ')}; the orrery's and ${project}'s are ${all.map(i => i.id).join(', ') || 'none'}`)
        return all.filter(i => (ids as string[]).includes(i.id)).map(i => i.text)
    }

    async deleteProject(id: string, actor = AGENT) {
        this.refuse(actor, `Deleting ${id}`, await this.ownedIn(id))
        const drawing = await this.drawingOn(id)
        if (drawing.length) throw conflict(`${drawing.join(', ')} ${drawing.length === 1 ? 'takes its' : 'take their'} releases from ${id}; give ${drawing.length === 1 ? 'it its' : 'them their'} own first (releases_from: null)`)
        await this.db.transaction(async () => {
            // Comments and issues first: the foreign keys would refuse the project going before them.
            await this.run('DELETE FROM comments WHERE project = ?', id)
            await this.run('UPDATE issues SET parent = NULL, chunk = NULL WHERE project = ?', id)
            await this.run('DELETE FROM issues WHERE project = ?', id)
            await this.run('DELETE FROM chunks WHERE project = ?', id)
            await this.run('DELETE FROM docs WHERE project = ?', id)
            await this.run('DELETE FROM doc_sections WHERE project = ?', id)
            await this.run('DELETE FROM doc_revisions WHERE project = ?', id)
            await this.run('DELETE FROM releases WHERE project = ?', id)
            await this.run('DELETE FROM issue_aliases WHERE project = ?', id)
            await this.run('DELETE FROM issue_links WHERE project = ? OR on_project = ?', id, id)
            await this.run('DELETE FROM chunk_aliases WHERE project = ?', id)
            await this.run('DELETE FROM signals WHERE project = ?', id)
            await this.run('DELETE FROM schedules WHERE project = ?', id)
            await this.run('DELETE FROM presets WHERE project = ?', id)
            await this.run('DELETE FROM projects WHERE id = ?', id)
        })
        this.changed(id)
    }
}
