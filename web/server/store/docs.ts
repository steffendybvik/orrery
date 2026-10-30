// A project's docs.
import type {DeletedDoc, Doc, DocRevision, DocRevisionSummary, DocSummary} from '#shared/roadmap'
import {fullId, looksFullDoc, shortId, slugify} from '#shared/roadmap'
import {badRequest, checkInput, conflict, isObject, notFound} from '../utils/input'
import type {Actor, DocRevisionRow, DocRow} from './schema'
import {AGENT, SLUG, DOC_FIELDS, docOf, docRevisionOf, docRevisionSummaryOf, stamp, summaryOf} from './schema'
import type {Input} from '../utils/input'
import {ChunkStore} from './chunks'
import {readDocSections, readDocSummaries} from './reads'

/** A doc's section as sent: trimmed, and none for an empty one; undefined leaves it as it is. */
export function sectionOf(value: Input[string]): string | null | undefined {
    if (value === undefined) return undefined
    const section = value === null ? '' : String(value).trim().slice(0, 60)
    return section || null
}

/** The largest id a revision's column can hold: past it, or not a number, there's no such revision. */
const MOST_REVISIONS = 2_147_483_647

/** A section's name as sent in `{name}`: trimmed, up to 60 characters, and not empty. */
function sectionName(body: unknown): string {
    const name = isObject(body) && typeof body.name === 'string' ? sectionOf(body.name) : null
    if (!name) throw badRequest('A section needs a name: {name}, up to 60 characters')
    return name
}

export abstract class DocStore extends ChunkStore {
    async listDocs(project: string, {q}: {q?: string} = {}): Promise<DocSummary[]> {
        await this.projectRow(project)
        return await readDocSummaries(this.db, project, q)
    }

    async doc(project: string, id: string): Promise<Doc> {
        const row = await this.docRow(project, await this.docId(project, id))
        return {...docOf(row), full_id: fullId('doc', row.id, (await this.projectRow(project)).uid)}
    }

    /** The doc's id, from its id or its full form on this board. */
    private async docId(project: string, id: string): Promise<string> {
        if (await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) return id
        return shortId('doc', id, (await this.projectRow(project)).uid) ?? id
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
            await this.run('INSERT INTO docs (project, id, title, body, position, section, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, String(input.body ?? ''), Number(input.position ?? await this.nextPosition('docs', project)), sectionOf(input.section) ?? null, actor.name, Number(actor.owner), now, now)
            await this.keepRevision(project, {id, title, body: String(input.body ?? '')}, actor)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('doc.created', project, id, actor)
        return await this.doc(project, id)
    }

    /** Creates the doc at `id` or replaces its title and text: how a repo's Markdown file is kept in sync. */
    async putDoc(project: string, id: string, body: unknown, actor = AGENT): Promise<{doc: Doc, created: boolean}> {
        await this.projectRow(project)
        id = await this.docId(project, id)
        if (!SLUG.test(id)) throw badRequest(`"${id}" isn't a doc id; use lowercase letters, digits and dashes`)
        const input = checkInput(body, DOC_FIELDS)
        if (input.id !== undefined && input.id !== id) throw badRequest(`The body's id "${input.id}" isn't the URL's "${id}"`)
        // Another board's full id isn't a new doc to make here.
        if (looksFullDoc(id) && !await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) throw notFound(`No doc "${id}" on ${project}`)
        if (!await this.get('SELECT 1 FROM docs WHERE project = ? AND id = ?', project, id)) return {doc: await this.createDoc(project, {...input, id}, actor), created: true}
        // A section left out keeps the one it has, so a repo's file synced in doesn't take it out of its group.
        return {doc: await this.updateDoc(project, id, {title: input.title, body: input.body ?? '', position: input.position, section: input.section}, actor), created: false}
    }

    /** Changes a doc; with `was`, only if it's still as that says, or it's a 409: a change the owner read against that text
     * doesn't land on any other (the chat's request, ORR-661). */
    async updateDoc(project: string, id: string, body: unknown, actor = AGENT, was?: {title: string, section: string | null, body: string}): Promise<Doc> {
        id = await this.docId(project, id)
        await this.docRow(project, id)
        const input = checkInput(body, DOC_FIELDS, true)
        if (input.id !== undefined && input.id !== id) throw badRequest("A doc's id can't change")
        const fields = {title: input.title === undefined ? undefined : String(input.title).trim(), body: input.body, position: input.position}
        const section = sectionOf(input.section)
        await this.db.transaction(async () => {
            const then = await this.docRow(project, id)
            if (was && (then.title !== was.title || then.body !== was.body || (then.section ?? null) !== was.section)) throw conflict(`Doc "${id}" has changed since then`)
            if (Object.values(fields).some(value => value !== undefined)) await this.update('docs', 'project = ? AND id = ?', [project, id], fields)
            // Only a change to its title or text is a revision: not a move, a new position, or the same text saved again.
            const now = await this.docRow(project, id)
            if (now.title !== then.title || now.body !== then.body) await this.keepRevision(project, now, actor)
            // Filing it elsewhere isn't a change to read, so it doesn't count as one (`updated_at`, what's unseen).
            if (section !== undefined) await this.run('UPDATE docs SET section = ? WHERE project = ? AND id = ?', section, project, id)
            await this.touchProject(project)
        })
        this.changed(project)
        if (input.title !== undefined || input.body !== undefined) this.tell('doc.changed', project, id, actor)
        return await this.doc(project, id)
    }

    /** Keeps a doc's title and text as they now are, or, with `deleted`, as they were when it went, and where it was filed. */
    private async keepRevision(project: string, doc: {id: string, title: string, body: string}, actor: Actor, deleted?: {section: string | null}) {
        await this.run('INSERT INTO doc_revisions (project, doc, title, body, section, deleted, created_by, session_name, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            project, doc.id, doc.title, doc.body, deleted?.section ?? null, Number(!!deleted), actor.name, actor.session ?? null, Number(actor.owner), stamp())
    }

    /** A doc's revisions, newest first, without their text; a deleted doc's too. */
    async docRevisions(project: string, sent: string): Promise<DocRevisionSummary[]> {
        await this.projectRow(project)
        const id = await this.docId(project, sent)
        const rows = await this.all<Omit<DocRevisionRow, 'body'>>('SELECT id, project, doc, title, section, deleted, created_by, session_name, owned, created_at FROM doc_revisions WHERE project = ? AND doc = ? ORDER BY id DESC', project, id)
        if (!rows.length) throw notFound(`No doc "${id}" in ${project}, and none deleted`)
        return rows.map(docRevisionSummaryOf)
    }

    async docRevision(project: string, id: string, revision: number): Promise<DocRevision> {
        return docRevisionOf(await this.docRevisionRow(project, id, revision))
    }

    private async docRevisionRow(project: string, sent: string, revision: number): Promise<DocRevisionRow> {
        await this.projectRow(project)
        const id = await this.docId(project, sent)
        const row = Number.isInteger(revision) && revision > 0 && revision <= MOST_REVISIONS
            ? await this.get<DocRevisionRow>('SELECT * FROM doc_revisions WHERE project = ? AND doc = ? AND id = ?', project, id, revision)
            : undefined
        if (!row) throw notFound(`No revision ${revision} of doc "${id}" in ${project}`)
        return row
    }

    /** The project's docs that are gone: those whose newest revision says so, the latest removed first. */
    async deletedDocs(project: string): Promise<DeletedDoc[]> {
        await this.projectRow(project)
        const rows = await this.all<DocRevisionRow>(`SELECT r.* FROM doc_revisions r
            WHERE r.project = ? AND r.deleted = 1 AND r.id = (SELECT max(n.id) FROM doc_revisions n WHERE n.project = r.project AND n.doc = r.doc)
            ORDER BY r.id DESC`, project)
        return rows.map(row => ({id: row.doc, title: row.title, summary: summaryOf(row.body), revision: row.id, deleted_by: row.created_by, deleted_at: row.created_at}))
    }

    /** Puts a revision's title and text back, as a new revision so it can be undone too. On a deleted doc, it comes back
     * where it was filed and with who made it, so one the owner made stays theirs. */
    async restoreDoc(project: string, sent: string, revision: number, actor = AGENT): Promise<{doc: Doc, created: boolean}> {
        const {doc: id, title, body} = await this.docRevisionRow(project, sent, revision)
        const live = await this.get<DocRow>('SELECT * FROM docs WHERE project = ? AND id = ?', project, id)
        if (live) return {doc: live.title === title && live.body === body ? await this.doc(project, id) : await this.updateDoc(project, id, {title, body}, actor), created: false}
        const now = stamp()
        await this.db.transaction(async () => {
            const first = await this.one<DocRevisionRow>('SELECT * FROM doc_revisions WHERE project = ? AND doc = ? ORDER BY id LIMIT 1', project, id)
            const last = await this.one<DocRevisionRow>('SELECT * FROM doc_revisions WHERE project = ? AND doc = ? ORDER BY id DESC LIMIT 1', project, id)
            await this.run('INSERT INTO docs (project, id, title, body, position, section, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                project, id, title, body, await this.nextPosition('docs', project), last.section, first.created_by, first.owned, first.created_at, now)
            await this.keepRevision(project, {id, title, body}, actor)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('doc.created', project, id, actor)
        return {doc: await this.doc(project, id), created: true}
    }

    async docSections(project: string): Promise<string[]> {
        await this.projectRow(project)
        return await readDocSections(this.db, project)
    }

    /** Makes a section with no docs in it yet, kept until it's deleted (ORR-560). */
    async createDocSection(project: string, body: unknown): Promise<string> {
        await this.projectRow(project)
        const name = sectionName(body)
        if ((await readDocSections(this.db, project)).includes(name)) throw conflict(`There is already a section "${name}" in ${project}`)
        await this.db.transaction(async () => {
            await this.run('INSERT INTO doc_sections (project, name, created_at) VALUES (?, ?, ?)', project, name, stamp())
            await this.touchProject(project)
        })
        this.changed(project)
        return name
    }

    /** Renames a section on every doc in it at once. Like moving a doc, it doesn't count as a change to them. */
    async renameDocSection(project: string, from: string, body: unknown): Promise<string> {
        await this.sectionThere(project, from)
        const name = sectionName(body)
        if (name === from) return name
        if ((await readDocSections(this.db, project)).includes(name)) throw conflict(`There is already a section "${name}" in ${project}; move its docs there instead`)
        await this.db.transaction(async () => {
            await this.run('UPDATE docs SET section = ? WHERE project = ? AND section = ?', name, project, from)
            await this.run('UPDATE doc_sections SET name = ? WHERE project = ? AND name = ?', name, project, from)
            await this.touchProject(project)
        })
        this.changed(project)
        return name
    }

    /** Deletes a section, keeping its docs: they're filed under none. */
    async deleteDocSection(project: string, name: string) {
        await this.sectionThere(project, name)
        await this.db.transaction(async () => {
            await this.run('UPDATE docs SET section = NULL WHERE project = ? AND section = ?', project, name)
            await this.run('DELETE FROM doc_sections WHERE project = ? AND name = ?', project, name)
            await this.touchProject(project)
        })
        this.changed(project)
    }

    private async sectionThere(project: string, name: string) {
        await this.projectRow(project)
        if (!(await readDocSections(this.db, project)).includes(name)) throw notFound(`No section "${name}" in ${project}`)
    }

    async deleteDoc(project: string, id: string, actor = AGENT) {
        id = await this.docId(project, id)
        const row = await this.docRow(project, id)
        this.refuse(actor, `Deleting doc "${id}"`, row.owned ? [`doc "${id}"`] : [])
        await this.db.transaction(async () => {
            await this.keepRevision(project, row, actor, {section: row.section})
            await this.run('DELETE FROM docs WHERE project = ? AND id = ?', project, id)
            await this.touchProject(project)
        })
        this.changed(project)
        this.tell('doc.deleted', project, id, actor)
    }
}
