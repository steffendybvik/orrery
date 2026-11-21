import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {readBody, setResponseStatus} from 'h3'
import type {Comment, Issue, Project} from '#shared/roadmap'
import IssueActivity from '~/components/IssueActivity.vue'

// An issue's activity on its page: who made it, its comments, the changes between them as words, the question it
// waits on quoted at the top, and the owner's own comments edited and deleted in place.
const BASE = '/api/projects/greenhouse/issues/GRE-1'
let comments: Comment[] = []
let activity: Record<string, unknown>[] = []
let sent: {method: string, path: string, body?: unknown}[] = []
/** A write is refused with a reason (true), or fails with none, as when orrery is down ('down'). */
let refuse: boolean | 'down' = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/epics', () => [{id: 7, title: 'Spring planting'}])
registerEndpoint('/api/notices', () => [])
let reads = 0
registerEndpoint(`${BASE}/comments`, {method: 'GET', handler: () => (reads++, comments)})
registerEndpoint(`${BASE}/activity`, () => activity)
registerEndpoint(`${BASE}/comments`, {method: 'POST', handler: async event => {
    const body = await readBody<{body: string}>(event)
    sent.push({method: 'POST', path: 'comments', body})
    return comment({id: 99, body: body.body, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', protected: true})
}})
function refused(event: H3Event, message: string) {
    setResponseStatus(event, 409)
    return {statusCode: 409, message}
}
// Comment 1 is the one these tests edit, delete and answer.
registerEndpoint(`${BASE}/comments/1`, {method: 'PATCH', handler: async event => {
    const body = await readBody<{body: string}>(event)
    sent.push({method: 'PATCH', path: 'comments/1', body})
    return {...comments.find(c => c.id === 1)!, body: body.body, updated_at: '2026-11-04T00:00:00Z'}
}})
registerEndpoint(`${BASE}/comments/1`, {method: 'DELETE', handler: event => {
    sent.push({method: 'DELETE', path: 'comments/1'})
    if (refuse) return refused(event, 'Only its writer can delete it')
    return {}
}})
registerEndpoint(`${BASE}/schedule-requests/1`, {method: 'POST', handler: async event => {
    const body = await readBody<{allow: boolean}>(event)
    sent.push({method: 'POST', path: 'schedule-requests/1', body})
    if (refuse === 'down') {
        setResponseStatus(event, 500)
        return {}
    }
    if (refuse) return refused(event, 'Asked again since')
    const asked = comments.find(c => c.id === 1)!
    return {...asked, body: 'Allowed.', schedule: {...asked.schedule!, state: 'allowed'}}
}})

function comment(more: Partial<Comment>): Comment {
    return {id: 1, body: 'A comment', created_by: 'claude', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', ...more} as Comment
}
const event = (id: number, field: string, after: string | null, before: string | null = null, more: Record<string, unknown> = {}) =>
    ({id, field, before, after, created_by: 'skoll', created_at: '2026-11-01T09:00:00Z', ...more})
const issue = (more: Record<string, unknown> = {}) => ({id: 'GRE-1', title: 'Water the ferns', created_by: 'skoll', created_at: '2026-11-01T08:00:00Z', updated_at: '1', ...more}) as unknown as Issue
const project = {id: 'greenhouse', name: 'Greenhouse', key: 'GRE', board: {milestones: [{id: 'care', title: 'Care'}]}} as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    comments = []
    activity = []
    sent = []
    reads = 0
    refuse = false
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
    useAppSettings().settings.value.statuses = [{id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'}, {id: 'in-progress', name: 'In progress', kind: 'started', color: 'amber'}] as never
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(task = issue()) {
    const wrapper = await mountSuspended(IssueActivity, {props: {project, issue: task}, attachTo: document.body})
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}
const lines = (wrapper: VueWrapper) => wrapper.findAll('ol > li').map(li => li.text().replace(/\s+/g, ' ').replace(/ · .*$/, ''))
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)!

describe('IssueActivity', () => {
    it("tells each change in words, one write's changes as one line", async () => {
        activity = [
            event(1, 'created', null),
            event(2, 'status', 'in-progress'),
            event(3, 'assignee', 'claude'),
            event(4, 'priority', 'P0', null, {created_at: '2026-11-01T09:01:00Z'}),
            event(5, 'labels', '["docs","bug"]', '["docs","old"]', {created_at: '2026-11-01T09:02:00Z'}),
            event(6, 'milestone', 'care', null, {created_at: '2026-11-01T09:03:00Z', created_by: 'claude', session_name: 'Var'}),
        ]
        const wrapper = await mount()
        expect(lines(wrapper)).toEqual([
            'Sköll created the issue',
            'Sköll moved it to In progress and assigned Agent',
            'Sköll set the priority to Urgent',
            'Sköll added the label bug and took off the label old',
            'Var put it in Care',
        ])
    })

    it.each([
        ['priority', null, 'P1', 'took the priority off'],
        ['assignee', null, 'claude', 'unassigned it'],
        ['claim', 'claude', null, 'took it up'],
        ['claim', 'claude', 'ada', 'took it over from ada'],
        ['claim', null, 'claude', 'let it go'],
        ['title', 'New', 'Old', 'renamed it from “Old”'],
        ['notes', 'x', 'y', 'edited the description'],
        ['parent', 'GRE-9', null, 'made it a sub-issue of GRE-9'],
        ['parent', null, 'GRE-9', 'made it a top-level issue'],
        ['project', 'greenhouse', 'kitchen', 'moved it here from kitchen'],
        ['uploaded', 'x', null, 'brought it in from a file'],
        ['proposal', 'pending', null, 'put it up as a proposal'],
        ['proposal', 'changes', 'pending', 'asked for changes to the proposal'],
        ['proposal', null, 'approved', 'put it on the roadmap'],
        ['proposal', null, 'pending', 'committed it'],
        ['milestone', null, 'care', 'took it out of its milestone'],
        ['milestone', 'gone', null, 'put it in gone'],
        ['external', '["T-2"]', '["T-1"]', 'linked the team task T-2 and unlinked the team task T-1'],
        ['github_issues', '["#5"]', '[]', 'linked the GitHub issue #5'],
        ['github_issues', null, '["#5"]', 'unlinked the GitHub issue #5'],
        ['epic', '7', null, 'put it in the epic Spring planting'],
        ['epic', '8', null, 'put it in the epic epic 8'],
        ['epic', null, '7', 'took it out of its epic'],
        ['model', 'opus', null, 'set its model to opus'],
        ['model', null, 'opus', 'let its kind pick its model'],
        ['effort', 'high', null, 'set its effort to high'],
        ['effort', null, 'high', 'let its kind pick its effort'],
        ['depends', '["GRE-2"]', '["GRE-3"]', 'made it depend on GRE-2 and took off its dependency on GRE-3'],
    ])('says a change to %s (%s, was %s) as “%s”', async (field, after, before, words) => {
        activity = [event(2, field, after, before)]
        const wrapper = await mount()
        await flushPromises()
        expect(lines(wrapper)[1]).toBe(`Sköll ${words}`)
    })

    it("leaves out a change it has no words for, and puts comments and changes in time order", async () => {
        activity = [event(2, 'mystery', 'x'), event(3, 'notes', 'b', 'a', {created_at: '2026-11-01T11:00:00Z'})]
        comments = [comment({id: 1, body: 'Done the first bed.', created_at: '2026-11-01T10:00:00Z'})]
        const wrapper = await mount()
        expect(lines(wrapper)).toEqual(['Sköll created the issue', expect.stringContaining('Done the first bed.'), 'Sköll edited the description'])
    })

    it('hands the page its comments once they are read', async () => {
        comments = [comment({id: 1})]
        const wrapper = await mount()
        expect(wrapper.emitted('comments')?.at(-1)).toEqual([[expect.objectContaining({id: 1})]])
    })

    it('quotes the question it waits on at the top, and Answer goes to the comment box', async () => {
        comments = [comment({id: 1, body: 'Oak or pine?', asks: 'decision', answered: false} as Partial<Comment>), comment({id: 2, body: 'Old one', asks: 'feedback', answered: true} as Partial<Comment>)]
        const wrapper = await mount(issue({waiting: 'decision'}))
        const waiting = wrapper.get('#waiting')
        expect(waiting.text()).toContain('Oak or pine?')
        expect(wrapper.text()).toContain('Decision needed')
        expect(wrapper.text()).toContain('Feedback answered')
        await button(wrapper, 'Answer').trigger('click')
        expect(document.activeElement?.tagName).toBe('TEXTAREA')
        // Not waiting: nothing quoted.
        await wrapper.setProps({issue: issue({updated_at: '2'})})
        await flushPromises()
        expect(wrapper.find('#waiting').exists()).toBe(false)
    })

    it('posts a comment from the box and lists it', async () => {
        const wrapper = await mount()
        await wrapper.get('textarea').setValue('Watered.')
        await button(wrapper, 'Comment').trigger('click')
        await flushPromises()
        expect(sent).toEqual([{method: 'POST', path: 'comments', body: {body: 'Watered.'}}])
        expect(wrapper.text()).toContain('Watered.')
    })

    it("edits the owner's own comment in place, and offers no edit on an agent's", async () => {
        comments = [comment({id: 1, body: 'Mine', created_by: 'skoll', protected: true} as Partial<Comment>), comment({id: 2, body: 'Theirs'})]
        const wrapper = await mount()
        expect(wrapper.findAll('button').filter(b => b.text() === 'Edit')).toHaveLength(1)
        await button(wrapper, 'Edit').trigger('click')
        await flushPromises()
        const box = wrapper.get('#comment-1 textarea')
        await box.setValue('Mine, edited')
        await wrapper.get('#comment-1').findAll('button').find(b => b.text() === 'Save')!.trigger('click')
        await flushPromises()
        expect(sent).toEqual([{method: 'PATCH', path: 'comments/1', body: {body: 'Mine, edited'}}])
        expect(wrapper.get('#comment-1').text()).toContain('Mine, edited')
        expect(wrapper.get('#comment-1').text()).toContain('edited')
        await vi.waitFor(() => expect(wrapper.find('#comment-1 textarea').exists()).toBe(false))
    })

    it('deletes one after asking in place, and says why when it can’t', async () => {
        comments = [comment({id: 1, body: 'Mine', created_by: 'skoll', protected: true} as Partial<Comment>)]
        const wrapper = await mount()
        await button(wrapper, 'Delete').trigger('click')
        expect(wrapper.text()).toContain('Delete the comment?')
        await button(wrapper, 'Cancel').trigger('click')
        expect(wrapper.text()).not.toContain('Delete the comment?')

        refuse = true
        await button(wrapper, 'Delete').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await flushPromises()
        expect(wrapper.find('#comment-1').exists()).toBe(true)
        await vi.waitFor(() => expect(wrapper.get('#comment-1').text()).toContain('Only its writer can delete it'))

        refuse = false
        await button(wrapper, 'Cancel').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await flushPromises()
        await vi.waitFor(() => expect(wrapper.find('#comment-1').exists()).toBe(false))
        expect(sent.filter(s => s.method === 'DELETE')).toHaveLength(2)
    })

    it("says plainly why it couldn't answer a schedule request when orrery gives no reason", async () => {
        comments = [comment({id: 1, body: 'May I?', schedule: {title: 'Nightly watering', changes: [{field: 'title', to: 'Nightly watering'}], body: {}, state: 'asked'}} as unknown as Partial<Comment>)]
        const wrapper = await mount()
        refuse = 'down'
        await button(wrapper, 'Deny').trigger('click')
        await vi.waitFor(() => expect(wrapper.get('#comment-1').text()).toContain("Couldn't deny it. Is orrery running?"))
        expect(wrapper.get('#comment-1').text()).not.toContain('it it')
    })

    it("answers a session's request for a schedule, and says so when it can't", async () => {
        const schedule = {id: 5, title: 'Nightly watering', changes: [{field: 'title', to: 'Nightly watering'}], body: {}, state: 'asked'}
        comments = [comment({id: 1, body: 'May I?', schedule} as unknown as Partial<Comment>)]
        const wrapper = await mount()
        refuse = true
        await button(wrapper, 'Allow').trigger('click')
        await vi.waitFor(() => expect(wrapper.get('#comment-1').text()).toContain('Asked again since'))
        refuse = false
        await button(wrapper, 'Allow').trigger('click')
        await flushPromises()
        expect(sent.filter(s => s.path === 'schedule-requests/1')).toEqual([
            {method: 'POST', path: 'schedule-requests/1', body: {allow: true}},
            {method: 'POST', path: 'schedule-requests/1', body: {allow: true}},
        ])
        await vi.waitFor(() => expect(wrapper.get('#comment-1').text()).toContain('Allowed and saved'))
        expect(wrapper.get('#comment-1').text()).toContain('Allowed.')
    })

    it("drops what comes back for an issue it has gone on from", async () => {
        comments = [comment({id: 1, body: 'From the first'})]
        const wrapper = await mount()
        expect(wrapper.text()).toContain('From the first')
        comments = []
        await wrapper.setProps({issue: issue({updated_at: '3'})})
        await flushPromises()
        await vi.waitFor(() => expect(wrapper.text()).not.toContain('From the first'))
        expect(reads).toBe(2)
    })
})
