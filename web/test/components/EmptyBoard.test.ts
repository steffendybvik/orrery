import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project, Session} from '#shared/roadmap'
import BoardPage from '~/pages/p/[project]/index.vue'

// An empty project's board has a way to start: New issue, like its neighbours, and connecting a session until one has.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', uid: 'x7k2m9qd', releases: [], docs: [], board: {chunks: [], kinds: {}}} as unknown as Project]
    useRoadmaps().sessions.value = {}
    useNewIssue().close()
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})

async function mount() {
    const wrapper = await mountSuspended(BoardPage, {route: '/p/greenhouse', attachTo: document.body, global: {stubs: {ViewToolbar: true, PageHeader: true}}})
    mounted.push(wrapper)
    return wrapper
}

describe("an empty project's board", () => {
    it('opens New issue for the project, and shows no API path', async () => {
        const wrapper = await mount()
        expect(wrapper.text()).toContain('Greenhouse has no issues yet.')
        expect(wrapper.text()).not.toContain('/api/')
        await wrapper.findAll('button').find(b => b.text() === 'New issue')!.trigger('click')
        expect(useNewIssue().target.value).toEqual({project: 'greenhouse'})
    })

    it('says to connect a session only until one has', async () => {
        const connect = 'a[href="/connect?project=greenhouse"]'
        expect((await mount()).find(connect).exists()).toBe(true)
        useRoadmaps().sessions.value = {greenhouse: [{id: 's1'} as Session]}
        expect((await mount()).find(connect).exists()).toBe(false)
    })
})
