import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {DocRevision} from '#shared/roadmap'
import DocHistory from '~/components/DocHistory.vue'

// A doc's past (ORR-675): its revisions newest first, what the picked one changed from the one before, and restoring
// one, or bringing back a removed doc from its last text.
const BASE = '/api/projects/greenhouse/docs/watering/revisions'
let revisions: DocRevision[] = []
let reads: Record<string, number> = {}
let restoring: number[] = []
let down = false

const revision = (id: number, more: Partial<DocRevision> = {}): DocRevision =>
    ({id, project: 'greenhouse', doc: 'watering', title: 'Watering', kind: 'doc', deleted: false, body: `Text ${id}`, created_by: 'skoll', created_at: `2026-11-0${id}T00:00:00Z`, ...more}) as DocRevision

registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint(BASE, event => {
    if (down) {
        setResponseStatus(event, 500)
        return {}
    }
    return revisions.map(({body: _, project: __, doc: ___, ...summary}) => summary)
})
for (const id of [1, 2, 3, 4]) {
    registerEndpoint(`${BASE}/${id}`, () => {
        reads[id] = (reads[id] ?? 0) + 1
        return revisions.find(r => r.id === id)
    })
    registerEndpoint(`${BASE}/${id}/restore`, {method: 'POST', handler: event => {
        restoring.push(id)
        if (down) {
            setResponseStatus(event, 409)
            return {statusCode: 409, message: 'The doc changed since'}
        }
        return {id: 'watering', title: 'Watering', body: revisions.find(r => r.id === id)!.body}
    }})
}

const mounted: VueWrapper[] = []
beforeEach(() => {
    reads = {}
    restoring = []
    down = false
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
    // Newest first, as the server lists them.
    revisions = [revision(3, {body: 'Water daily.', session_name: 'Var', created_by: 'claude'}), revision(2, {body: 'Water weekly.', title: 'Watering plan'}), revision(1, {body: 'Water weekly.', title: 'Watering plan'})]
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(props: Record<string, unknown> = {}) {
    const wrapper = await mountSuspended(DocHistory, {props: {project: 'greenhouse', doc: 'watering', ...props}, attachTo: document.body})
    mounted.push(wrapper)
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.findAll('li')).not.toHaveLength(0))
    return wrapper
}
/** Each row as its words, and Current on the one that is. */
const rows = (wrapper: VueWrapper) => wrapper.findAll('li button').map(b => [b.get('.flex-1').text().replace(/\s+/g, ' '), b.text().includes('Current') ? 'Current' : ''].filter(Boolean).join(' '))
const pick = (wrapper: VueWrapper, at: number) => wrapper.findAll('li button')[at]!.trigger('click')
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)

describe('DocHistory', () => {
    it('lists the revisions, newest first, labelled by what they did and who', async () => {
        const wrapper = await mount()
        expect(rows(wrapper)).toEqual([
            'Edited by Agent · Var Current',
            'Edited by Sköll',
            'First version by Sköll',
        ])
        expect(wrapper.findAll('li button')[0]!.attributes('aria-current')).toBe('true')
    })

    it('shows the newest against the one before, with no restore, as it is what the doc says', async () => {
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('Watering plan'))
        expect(wrapper.find('.line-through').text()).toBe('Watering plan')
        expect(button(wrapper, 'Restore this version')).toBeUndefined()
    })

    it('says only the title changed, or nothing did, and reads each revision once', async () => {
        const wrapper = await mount()
        await pick(wrapper, 1)
        await vi.waitFor(() => expect(wrapper.text()).toContain('The same text as the version before.'))
        revisions[1] = {...revisions[1]!, title: 'Watering, renamed'}
        await pick(wrapper, 2)
        await pick(wrapper, 1)
        await vi.waitFor(() => expect(wrapper.text()).toContain('The same text as the version before.'))
        expect(reads[2]).toBe(1)
        revisions = [revision(3), revision(2, {body: 'Same', title: 'New'}), revision(1, {body: 'Same', title: 'Old'})]
        await wrapper.setProps({updatedAt: 'later'})
        await flushPromises()
        expect(reads[1]).toBe(1)
    })

    it('restores an older one after asking, and says why when it fails', async () => {
        const wrapper = await mount()
        await pick(wrapper, 2)
        await vi.waitFor(() => expect(button(wrapper, 'Restore this version')).toBeDefined())
        await button(wrapper, 'Restore this version')!.trigger('click')
        expect(wrapper.text()).toContain('Restore this version?')
        await button(wrapper, 'Cancel')!.trigger('click')
        expect(wrapper.text()).not.toContain('Restore this version?')

        down = true
        await button(wrapper, 'Restore this version')!.trigger('click')
        await button(wrapper, 'Restore')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('The doc changed since'))
        expect(wrapper.emitted('restored')).toBeUndefined()

        down = false
        await button(wrapper, 'Restore this version')!.trigger('click')
        await button(wrapper, 'Restore')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.emitted('restored')).toHaveLength(1))
        expect(wrapper.emitted('restored')![0]).toEqual([expect.objectContaining({body: 'Water weekly.'})])
        expect(restoring).toEqual([1, 1])
    })

    it('brings back a removed doc from its last text', async () => {
        revisions = [revision(4, {deleted: true, body: 'Last words'}), revision(3, {body: 'Last words'})]
        const wrapper = await mount()
        expect(rows(wrapper)[0]).toBe('Removed by Sköll')
        expect(rows(wrapper)[0]).not.toContain('Current')
        await vi.waitFor(() => expect(wrapper.text()).toContain('The doc was removed here. This is the text it had.'))
        expect(wrapper.text()).toContain('Last words')
        await button(wrapper, 'Bring it back')!.trigger('click')
        expect(wrapper.text()).toContain('Bring it back with this text?')
        await button(wrapper, 'Bring back')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.emitted('restored')).toHaveLength(1))
        expect(restoring).toEqual([4])
    })

    it('stays on the one picked as the doc changes, and goes to the newest when it is gone', async () => {
        const wrapper = await mount()
        await pick(wrapper, 1)
        revisions = [revision(4), ...revisions]
        await wrapper.setProps({updatedAt: 'once'})
        await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(4))
        expect(wrapper.findAll('li button')[2]!.attributes('aria-current')).toBe('true')
        revisions = [revision(4), revision(3)]
        await wrapper.setProps({updatedAt: 'twice'})
        await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(2))
        expect(wrapper.findAll('li button')[0]!.attributes('aria-current')).toBe('true')
    })

    it("says it couldn't read the history, not that it couldn't save", async () => {
        down = true
        const wrapper = await mountSuspended(DocHistory, {props: {project: 'greenhouse', doc: 'watering'}, attachTo: document.body})
        mounted.push(wrapper)
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't read it. Is orrery running?"))
    })
})
