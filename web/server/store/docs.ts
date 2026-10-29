// A project's docs.
import type {Doc, DocSummary} from '#shared/roadmap'
import {slugify} from '#shared/roadmap'
import {badRequest, checkInput, conflict} from '../utils/input'
import {AGENT, SLUG, DOC_FIELDS, docOf, stamp} from './schema'
import {ChunkStore} from './chunks'

export abstract class DocStore extends ChunkStore {
    async listDocs(project: string, {q}: {q?: string} = {}): Promise<DocSummary[]> {
        await this.projectRow(project)
        return await this.docSummaries(project, q)
    }

    async doc(project: string, id: string): Promise<Doc> {
        return docOf(await this.docRow(project, id))
    }

    async createDoc(project: string, body: unknown, actor = AGENT): Promise<Doc> {
        await this.projectRow(project)
        const input = checkInput(body, DOC_FIELDS)
        const title = String(input.title).trim()
        let id = input.id ? String(input.id) : slugify(title) || 'doc'
        if (input.id) {
            if (await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) throw conflict(`There is already a doc "${id}" in ${project}`)
        } else {
            // The number trims the name to fit, so the id stays one `PUT /docs/:id` takes (at most 40).
            const base = id
            for (let n = 2; await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id); n++) id = `${base.slice(0, 39 - String(n).length).replace(/-+$/, '')}-${n}`
        }
        const now = stamp()
        await this.db.transaction(async () => {
            await this.run('INSERT INTO docs (project, id, title, body, position, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, String(input.body ?? ''), Number(input.position ?? await this.nextPosition('docs', project)), actor.name, Number(actor.owner), now, now)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('doc.created', project, id, actor)
        return await this.doc(project, id)
    }

    /** Creates the doc at `id` or replaces its title and text: how a repo's Markdown file is kept in sync. */
    async putDoc(project: string, id: string, body: unknown, actor = AGENT): Promise<{doc: Doc, created: boolean}> {
        await this.projectRow(project)
        if (!SLUG.test(id)) throw badRequest(`"${id}" isn't a doc id; use lowercase letters, digits and dashes`)
        const input = checkInput(body, DOC_FIELDS)
        if (input.id !== undefined && input.id !== id) throw badRequest(`The body's id "${input.id}" isn't the URL's "${id}"`)
        if (!await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) return {doc: await this.createDoc(project, {...input, id}, actor), created: true}
        return {doc: await this.updateDoc(project, id, {title: input.title, body: input.body ?? '', position: input.position}, actor), created: false}
    }

    async updateDoc(project: string, id: string, body: unknown, actor = AGENT): Promise<Doc> {
        await this.docRow(project, id)
        const input = checkInput(body, DOC_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A doc's id can't change")
        await this.db.transaction(async () => {
            await this.update('docs', 'project = ? AND id = ?', [project, id], {
                title: input.title === undefined ? undefined : String(input.title).trim(),
                body: input.body,
                position: input.position,
            })
            await this.touchProject(project)
        })
        this.changed(project)
        if (input.title !== undefined || input.body !== undefined) this.tell('doc.changed', project, id, actor)
        return await this.doc(project, id)
    }

    async deleteDoc(project: string, id: string, actor = AGENT) {
        const row = await this.docRow(project, id)
        this.refuse(actor, `Deleting doc "${id}"`, row.owned ? [`doc "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.run('DELETE FROM docs WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('doc.deleted', project, id, actor)
    }
}
