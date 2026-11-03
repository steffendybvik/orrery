import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Session} from '#shared/roadmap'
import StatusFocus from '~/components/StatusFocus.vue'

// On a status group of a chunk's page: asking one session, or all, to work through its issues. It's there only while a
// session is listening, and never on Proposed or a closed status, as there's no work to take up in those.
let sent: unknown[] = []
let refused = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/projects/greenhouse/chunks/3/focus', {method: 'POST', handler: async event => {
    if (refused) {
        setResponseStatus(event, 400)
        return {message: 'no'}
    }
    sent.push(await readBody(event))
    return {}
}})

const session = (id: string, more: Partial<Session> = {}) => ({id, name: id, project: 'greenhouse', state: 'idle', listening: true, since: '', started_at: '', ...more}) as Session
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    refused = false
    useAppSettings().settings.value.statuses = [
        {id: 'proposed', name: 'Proposed', kind: 'proposed', color: 'violet'},
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'done', name: 'Done', kind: 'done', color: 'green'},
        {id: 'canceled', name: 'Canceled', kind: 'canceled', color: 'slate'},
    ] as never
    useRoadmaps().sessions.value = {greenhouse: [session('shelves'), session('jars'), session('deaf', {listening: false})]}
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.useRealTimers()
})

async function mount(column = 'todo') {
    const wrapper = await mountSuspended(StatusFocus, {props: {project: 'greenhouse', chunk: '3', column}, attachTo: document.body})
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
const open = async (wrapper: VueWrapper) => {
    await wrapper.find('button').trigger('click')
    await expect.poll(() => new DOMWrapper(document.body).findAll('[role="menuitem"]').length).toBeGreaterThan(0)
    return new DOMWrapper(document.body).findAll('[role="menuitem"]')
}

describe('StatusFocus', () => {
    it("isn't there with nobody listening, nor on Proposed or a closed status", async () => {
        for (const column of ['proposed', 'done', 'canceled']) expect((await mount(column)).find('button').exists()).toBe(false)
        useRoadmaps().sessions.value = {greenhouse: [session('deaf', {listening: false})]}
        expect((await mount()).find('button').exists()).toBe(false)
    })

    it('offers all of them and each listening one, and sends to all as *', async () => {
        const wrapper = await mount()
        expect(wrapper.text()).toContain('Focus on all Todo')
        const items = await open(wrapper as VueWrapper)
        expect(items.map(i => i.text())).toEqual(['All 2 sessions', 'shelves', 'jars'])
        await items[0]!.trigger('click')
        await expect.poll(() => sent).toEqual([{status: 'todo', session: '*'}])
        await expect.poll(() => wrapper.text()).toContain('Sent to 2 sessions')
    })

    it('sends to the one picked, and with one listening offers no All', async () => {
        const wrapper = await mount()
        const items = await open(wrapper as VueWrapper)
        await items[2]!.trigger('click')
        await expect.poll(() => sent).toEqual([{status: 'todo', session: 'jars'}])
        await expect.poll(() => wrapper.text()).toContain('Sent to jars')
        wrapper.unmount()
        mounted.pop()

        useRoadmaps().sessions.value = {greenhouse: [session('shelves')]}
        const one = await mount()
        expect((await open(one as VueWrapper)).map(i => i.text())).toEqual(['shelves'])
    })

    it("says when it couldn't send", async () => {
        refused = true
        const wrapper = await mount()
        await (await open(wrapper as VueWrapper))[1]!.trigger('click')
        await expect.poll(() => wrapper.text()).toContain("Couldn't send")
        expect(sent).toEqual([])
    })
})
