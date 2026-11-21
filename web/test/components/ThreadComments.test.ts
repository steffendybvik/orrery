import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {readBody, setResponseStatus} from 'h3'
import type {ThreadComment} from '#shared/roadmap'
import ThreadComments from '~/components/ThreadComments.vue'
import CommentBox from '~/components/CommentBox.vue'

// The comments on a milestone's or an epic's page (ORR-977), and the box that writes one, as the issue's do: oldest
// first, read again on `reload`, and the owner's own edited and deleted in place.
const URL = '/api/projects/greenhouse/milestones/care/comments'
let comments: ThreadComment[] = []
let sent: {method: string, path: string, body?: unknown}[] = []
/** A write is refused with a reason (true), or fails with none ('down'). */
let refuse: boolean | 'down' = false
let reads = 0

function refused(event: H3Event) {
    if (refuse === 'down') {
        setResponseStatus(event, 500)
        return {}
    }
    setResponseStatus(event, 409)
    return {statusCode: 409, message: 'Only its writer can change it'}
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/notices', () => [])
registerEndpoint(URL, {method: 'GET', handler: event => {
    reads++
    return refuse === 'down' ? refused(event) : comments
}})
registerEndpoint(URL, {method: 'POST', handler: async event => {
    const body = await readBody<{body: string}>(event)
    sent.push({method: 'POST', path: '', body})
    if (refuse) return refused(event)
    return comment({id: 9, body: body.body, created_at: '2026-11-01T09:30:00Z', updated_at: '2026-11-01T09:30:00Z', created_by: 'skoll', protected: true})
}})
registerEndpoint(`${URL}/1`, {method: 'PATCH', handler: async event => {
    const body = await readBody<{body: string}>(event)
    sent.push({method: 'PATCH', path: '/1', body})
    if (refuse) return refused(event)
    return {...comments[0]!, body: body.body, updated_at: '2026-11-05T00:00:00Z'}
}})
registerEndpoint(`${URL}/1`, {method: 'DELETE', handler: event => {
    sent.push({method: 'DELETE', path: '/1'})
    return refuse ? refused(event) : {}
}})

function comment(more: Partial<ThreadComment>): ThreadComment {
    return {id: 1, body: 'A comment', created_by: 'claude', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', ...more} as ThreadComment
}

const mounted: VueWrapper[] = []
beforeEach(() => {
    comments = []
    sent = []
    refuse = false
    reads = 0
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(props: Record<string, unknown> = {}) {
    const wrapper = await mountSuspended(ThreadComments, {props: {url: '/projects/greenhouse/milestones/care/comments', ...props}, attachTo: document.body})
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
}
const button = (within: Pick<VueWrapper, 'findAll'>, text: string) => within.findAll('button').find(b => b.text().startsWith(text))!
const said = (wrapper: VueWrapper) => wrapper.findAll('li').map(li => li.find('.rounded-xl').text())

describe('ThreadComments', () => {
    it('lists the comments, who wrote them and whether they were edited', async () => {
        comments = [comment({id: 1, body: 'First', created_by: 'skoll'}), comment({id: 2, body: 'Second', session_name: 'Var', updated_at: '2026-11-02T00:00:00Z'})]
        const wrapper = await mount()
        expect(said(wrapper)).toEqual(['First', 'Second'])
        expect(wrapper.get('#comment-1').text()).toContain('Sköll')
        expect(wrapper.get('#comment-2').text()).toContain('Var')
        expect(wrapper.get('#comment-2').text()).toContain('edited')
        expect(wrapper.get('#comment-1').text()).not.toContain('edited')
    })

    it("says so when it can't read them", async () => {
        refuse = 'down'
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't read the comments. Is orrery running?"))
        expect(wrapper.find('ol').exists()).toBe(false)
    })

    it('reads them again when reload changes, so a new one shows up', async () => {
        const wrapper = await mount({reload: 1})
        expect(reads).toBe(1)
        comments = [comment({id: 3, body: 'Arrived later'})]
        await wrapper.setProps({reload: 2})
        await vi.waitFor(() => expect(wrapper.text()).toContain('Arrived later'))
        expect(reads).toBe(2)
    })

    it('posts a new one and puts it in time order', async () => {
        comments = [comment({id: 1, body: 'At ten'})]
        const wrapper = await mount()
        await wrapper.get('textarea').setValue('  At half nine  ')
        await button(wrapper, 'Comment').trigger('click')
        await vi.waitFor(() => expect(said(wrapper)).toEqual(['At half nine', 'At ten']))
        expect(sent).toEqual([{method: 'POST', path: '', body: {body: 'At half nine'}}])
        expect(wrapper.get('textarea').element.value).toBe('')
    })

    it("edits the owner's own in place, and only theirs", async () => {
        comments = [comment({id: 1, body: 'Mine', created_by: 'skoll', protected: true}), comment({id: 2, body: 'Theirs'})]
        const wrapper = await mount()
        expect(wrapper.get('#comment-2').findAll('button').map(b => b.text())).not.toContain('Edit')
        await button(wrapper.get('#comment-1'), 'Edit').trigger('click')
        await flushPromises()
        await wrapper.get('#comment-1 textarea').setValue('Mine, better')
        await button(wrapper.get('#comment-1'), 'Save').trigger('click')
        await vi.waitFor(() => expect(wrapper.find('#comment-1 textarea').exists()).toBe(false))
        expect(said(wrapper)[0]).toBe('Mine, better')
        expect(sent).toEqual([{method: 'PATCH', path: '/1', body: {body: 'Mine, better'}}])
    })

    it('deletes one after asking, and keeps it with the reason when that fails', async () => {
        comments = [comment({id: 1, body: 'Mine', created_by: 'skoll', protected: true})]
        const wrapper = await mount()
        refuse = true
        await button(wrapper, 'Delete').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await vi.waitFor(() => expect(wrapper.get('#comment-1').text()).toContain('Only its writer can change it'))
        refuse = false
        await button(wrapper, 'Cancel').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await button(wrapper, 'Delete').trigger('click')
        await vi.waitFor(() => expect(wrapper.find('#comment-1').exists()).toBe(false))
        expect(sent.map(s => s.method)).toEqual(['DELETE', 'DELETE'])
    })
})

describe('CommentBox', () => {
    async function box(props: Record<string, unknown> = {}) {
        const wrapper = await mountSuspended(CommentBox, {props: {url: '/projects/greenhouse/milestones/care/comments', ...props}, attachTo: document.body})
        mounted.push(wrapper)
        return wrapper
    }

    it("won't post nothing, and posts on ⌘↵", async () => {
        const wrapper = await box()
        const post = button(wrapper, 'Comment')
        expect(post.attributes('disabled')).toBeDefined()
        await wrapper.get('textarea').setValue('   ')
        expect(post.attributes('disabled')).toBeDefined()
        await wrapper.get('textarea').trigger('keydown', {key: 'Enter', metaKey: true})
        await flushPromises()
        expect(sent).toEqual([])
        await wrapper.get('textarea').setValue('By keys')
        await wrapper.get('textarea').trigger('keydown', {key: 'Enter', ctrlKey: true})
        await vi.waitFor(() => expect(wrapper.emitted('posted')).toHaveLength(1))
        expect(sent).toEqual([{method: 'POST', path: '', body: {body: 'By keys'}}])
    })

    it("says it couldn't post, and keeps the text", async () => {
        refuse = 'down'
        const wrapper = await box()
        await wrapper.get('textarea').setValue('Keep me')
        await button(wrapper, 'Comment').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't post. Is orrery running?"))
        expect(wrapper.get('textarea').element.value).toBe('Keep me')
        expect(wrapper.emitted('posted')).toBeUndefined()
    })

    it('edits a comment: focused, saved, and cancelled by Esc or Cancel', async () => {
        const wrapper = await box({comment: comment({id: 1, body: 'Old'})})
        await flushPromises()
        const area = wrapper.get('textarea')
        expect(area.element.value).toBe('Old')
        expect(area.attributes('aria-label')).toBe('Edit comment')
        expect(document.activeElement).toBe(area.element)
        await area.trigger('keydown', {key: 'Escape'})
        await button(wrapper, 'Cancel').trigger('click')
        expect(wrapper.emitted('cancel')).toHaveLength(2)

        refuse = 'down'
        await button(wrapper, 'Save').trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't save. Is orrery running?"))
    })

    it('posts to an issue when given one', async () => {
        const at: string[] = []
        registerEndpoint('/api/projects/greenhouse/issues/GRE-1/comments', {method: 'POST', handler: async event => {
            at.push((await readBody<{body: string}>(event)).body)
            return comment({id: 4})
        }})
        const wrapper = await box({url: undefined, project: 'greenhouse', issue: 'GRE-1'})
        await wrapper.get('textarea').setValue('On the issue')
        await button(wrapper, 'Comment').trigger('click')
        await vi.waitFor(() => expect(at).toEqual(['On the issue']))
    })
})
