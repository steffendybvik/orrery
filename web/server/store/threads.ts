// Comments on a milestone and on an epic (ORR-977): words on its page, kept in tables of their own (`milestone_comments`,
// `epic_comments`) so an issue's comments, with their asks, the bell and the sessions they reach, stay as they are.
// Who may change one is an issue comment's rule: the owner's are theirs, a member's are theirs and their agents'. They
// ask nothing and wake no session; open pages read them again as the milestone's project, or the epics, change.
import type {ThreadComment} from '#shared/roadmap'
import {checkInput, notFound} from '../utils/input'
import {refusedFor} from '../utils/permission'
import type {Actor, ThreadCommentRow} from './schema'
import {AGENT, stamp} from './schema'
import {CommentStore} from './comments'

/** What a comment on a milestone or an epic takes: its words. */
const THREAD_FIELDS = {body: {type: 'string', required: true}} as const

/** Where one thread's comments are kept, and what's told when they change. */
interface Thread {
    table: 'milestone_comments' | 'epic_comments'
    /** The columns naming what it's on, and their values. */
    on: Record<string, string | number>
    /** What it's on, in a message: `milestone 3`, `epic 2`. */
    what: string
    /** The permissions row its writes are under. */
    row: 'comments.write' | 'epics.comment'
}

export function threadCommentOf(row: ThreadCommentRow): ThreadComment {
    return {
        id: Number(row.id),
        ...row.project === undefined ? {} : {project: row.project},
        ...row.milestone === undefined ? {} : {milestone: row.milestone},
        ...row.epic === undefined ? {} : {epic: Number(row.epic)},
        body: row.body, created_by: row.created_by, ...row.session_name ? {session_name: row.session_name} : {},
        protected: !!row.owned, created_at: row.created_at, updated_at: row.updated_at,
    }
}

export abstract class ThreadStore extends CommentStore {
    private async milestoneThread(project: string, milestone: string): Promise<Thread> {
        const id = await this.milestoneId(project, milestone)
        await this.milestoneRow(project, id)
        return {table: 'milestone_comments', on: {project, milestone: id}, what: `milestone ${id}`, row: 'comments.write'}
    }

    private async epicThread(epic: number): Promise<Thread> {
        const row = Number.isInteger(epic) ? await this.get('SELECT 1 FROM epics WHERE id = ?', epic) : undefined
        if (!row) throw notFound(`No epic ${epic}: GET /api/epics lists them`)
        return {table: 'epic_comments', on: {epic}, what: `epic ${epic}`, row: 'epics.comment'}
    }

    private where(thread: Thread): [string, (string | number)[]] {
        const columns = Object.keys(thread.on)
        return [columns.map(c => `${c} = ?`).join(' AND '), Object.values(thread.on)]
    }

    private async listThread(thread: Thread): Promise<ThreadComment[]> {
        const [where, keys] = this.where(thread)
        return (await this.all<ThreadCommentRow>(`SELECT * FROM ${thread.table} WHERE ${where} ORDER BY created_at, id`, ...keys)).map(threadCommentOf)
    }

    private async threadRow(thread: Thread, id: number): Promise<ThreadCommentRow> {
        const [where, keys] = this.where(thread)
        const row = Number.isInteger(id) ? await this.get<ThreadCommentRow>(`SELECT * FROM ${thread.table} WHERE id = ? AND ${where}`, id, ...keys) : undefined
        if (!row) throw notFound(`No comment ${id} on ${thread.what}`)
        return row
    }

    /** Marks what the thread is on as changed, so open pages read it again: the milestone's project, or the epics. */
    private async touched(thread: Thread) {
        const now = stamp()
        if (thread.table === 'epic_comments') await this.run('UPDATE epics SET updated_at = ? WHERE id = ?', now, Number(thread.on.epic))
        else await this.touchProject(String(thread.on.project))
    }

    private threadChanged(thread: Thread) {
        if (thread.table === 'epic_comments') this.sayEpics()
        else this.changed(String(thread.on.project))
    }

    /** The owner's words are theirs: nobody else edits or deletes them. */
    private leaveOwners(thread: Thread, row: ThreadCommentRow, actor: Actor, action: string) {
        if (!row.owned || actor.owner) return
        if (thread.row === 'epics.comment') throw refusedFor('epics.comment', `${action} is the owner's call: comment ${row.id} was made by the owner`)
        throw refusedFor('comments.write', `${action} is the owner's call: comment ${row.id} was made by the owner`)
    }

    private async addTo(thread: Thread, body: unknown, actor: Actor): Promise<ThreadComment> {
        const input = checkInput(body, THREAD_FIELDS)
        const {person, by_agent} = await this.voiceOf(actor)
        const now = stamp()
        const columns = Object.keys(thread.on)
        const id = await this.db.transaction(async () => {
            const {id} = await this.one<{id: number}>(`INSERT INTO ${thread.table} (${columns.join(', ')}, body, created_by, session_name, owned, person, by_agent, created_at, updated_at)
                VALUES (${columns.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            ...Object.values(thread.on), String(input.body), actor.name, actor.session ?? null, Number(actor.owner), person, by_agent, now, now)
            await this.touched(thread)
            return Number(id)
        })
        this.threadChanged(thread)
        return threadCommentOf(await this.threadRow(thread, id))
    }

    private async editIn(thread: Thread, id: number, body: unknown, actor: Actor): Promise<ThreadComment> {
        const row = await this.threadRow(thread, id)
        this.leaveOwners(thread, row, actor, `Editing comment ${id}`)
        await this.leaveTheirWords(row, actor, `Editing comment ${id}`)
        const input = checkInput(body, THREAD_FIELDS, true)
        await this.db.transaction(async () => {
            await this.update(thread.table, 'id = ?', [id], {body: input.body})
            await this.touched(thread)
        })
        this.threadChanged(thread)
        return threadCommentOf(await this.threadRow(thread, id))
    }

    private async removeFrom(thread: Thread, id: number, actor: Actor) {
        const row = await this.threadRow(thread, id)
        this.leaveOwners(thread, row, actor, `Deleting comment ${id}`)
        await this.leaveTheirWords(row, actor, `Deleting comment ${id}`)
        await this.db.transaction(async () => {
            await this.run(`DELETE FROM ${thread.table} WHERE id = ?`, id)
            await this.touched(thread)
        })
        this.threadChanged(thread)
    }

    /** A milestone's comments, oldest first. */
    async listMilestoneComments(project: string, milestone: string): Promise<ThreadComment[]> {
        return await this.listThread(await this.milestoneThread(project, milestone))
    }

    async createMilestoneComment(project: string, milestone: string, body: unknown, actor = AGENT): Promise<ThreadComment> {
        return await this.addTo(await this.milestoneThread(project, milestone), body, actor)
    }

    async updateMilestoneComment(project: string, milestone: string, id: number, body: unknown, actor = AGENT): Promise<ThreadComment> {
        return await this.editIn(await this.milestoneThread(project, milestone), id, body, actor)
    }

    async deleteMilestoneComment(project: string, milestone: string, id: number, actor = AGENT) {
        await this.removeFrom(await this.milestoneThread(project, milestone), id, actor)
    }

    /** An epic's comments, oldest first. */
    async listEpicComments(epic: number): Promise<ThreadComment[]> {
        return await this.listThread(await this.epicThread(epic))
    }

    async createEpicComment(epic: number, body: unknown, actor = AGENT): Promise<ThreadComment> {
        return await this.addTo(await this.epicThread(epic), body, actor)
    }

    async updateEpicComment(epic: number, id: number, body: unknown, actor = AGENT): Promise<ThreadComment> {
        return await this.editIn(await this.epicThread(epic), id, body, actor)
    }

    async deleteEpicComment(epic: number, id: number, actor = AGENT) {
        await this.removeFrom(await this.epicThread(epic), id, actor)
    }
}
