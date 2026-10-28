// Chunks: a project's roadmap, in order.
import type {Issue} from '#shared/roadmap'
import {checkInput} from '../utils/input'
import type {ChunkRecord, ChunkRow} from './schema'
import {AGENT, CHUNK_FIELDS, nullable, stamp} from './schema'
import {PresetStore} from './presets'
import {known} from '#shared/known'

export abstract class ChunkStore extends PresetStore {
    async listChunks(project: string): Promise<ChunkRecord[]> {
        const {board} = await this.project(project)
        return (await this.all<ChunkRow>('SELECT * FROM chunks WHERE project = ? ORDER BY position, created_at', project))
            .map(row => this.chunkRecord(row, known(board.chunks.find(c => c.id === row.id), `chunk ${row.id} on the board`)))
    }

    async chunk(project: string, id: string): Promise<ChunkRecord & {tasks: Issue[]}> {
        id = await this.chunkId(project, id)
        const row = await this.chunkRow(project, id)
        const view = known((await this.project(project)).board.chunks.find(c => c.id === id), `chunk ${id} on the board`)
        return {...this.chunkRecord(row, view), tasks: view.tasks}
    }

    async createChunk(project: string, body: unknown, actor = AGENT): Promise<ChunkRecord & {tasks: Issue[]}> {
        await this.projectRow(project)
        const input = checkInput(body, CHUNK_FIELDS)
        const title = String(input.title).trim()
        const now = stamp()
        const id = await this.db.transaction(async () => {
            const id = await this.nextId(project, 'chunk')
            await this.run('INSERT INTO chunks (project, id, title, summary, priority, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, nullable(input.summary), nullable(input.priority), Number(input.position ?? await this.nextPosition('chunks', project)), actor.name, Number(actor.owner), now, now)
            await this.touchProject(project)
            return id
        })
        this.changed(project)
        this.tell('chunk.created', project, id, actor)
        return await this.chunk(project, id)
    }

    async updateChunk(project: string, id: string, body: unknown): Promise<ChunkRecord & {tasks: Issue[]}> {
        id = await this.chunkId(project, id)
        await this.chunkRow(project, id)
        const input = checkInput(body, CHUNK_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update('chunks', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                summary: input.summary,
                priority: input.priority,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        return await this.chunk(project, id)
    }

    /** Its issues stay, in no chunk. */
    async deleteChunk(project: string, id: string, actor = AGENT) {
        id = await this.chunkId(project, id)
        const row = await this.chunkRow(project, id)
        this.refuse(actor, `Deleting chunk "${id}"`, row.owned ? [`chunk "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.run('UPDATE issues SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM chunk_aliases WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM signals WHERE project = ? AND chunk = ?', project, id)
            // Schedules that made issues in it make them in no chunk from now on.
            await this.run('UPDATE schedules SET chunk = NULL WHERE project = ? AND chunk = ?', project, id)
            await this.run('DELETE FROM chunks WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
    }
}
