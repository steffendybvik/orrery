import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project} from '#shared/roadmap'
import DocPage from '~/pages/p/[project]/docs/[doc].vue'

// A doc's page copies its id or its full address, and each button says which.
const doc = {id: 'potting-mix', project: 'greenhouse', title: 'Potting mix', body: 'Mostly peat.', created_by: 'claude', updated_at: '2026-10-30T12:00:00.000Z'}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/greenhouse/docs/potting-mix', () => doc)

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', uid: 'x7k2m9qd', releases: [], docs: [doc], board: {chunks: []}} as unknown as Project]
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.unstubAllGlobals()
})

async function mount() {
    const wrapper = await mountSuspended(DocPage, {route: '/p/greenhouse/docs/potting-mix', attachTo: document.body, global: {stubs: {DocsNav: true}}})
    mounted.push(wrapper)
    await vi.waitFor(() => expect(wrapper.find('[aria-label="Copy this doc\'s URL"]').exists()).toBe(true))
    return wrapper
}

describe('a doc page', () => {
    it.each([
        ['Copy URL', "this doc's URL", `${location.origin}/p/greenhouse/docs/potting-mix`],
        ['Copy id', "this doc's id", 'doc-potting-mix-x7k2m9qd'],
    ])('%s copies what it says', async (label, name, text) => {
        const writeText = vi.fn(async () => {})
        vi.stubGlobal('navigator', {...navigator, clipboard: {writeText}})
        const button = (await mount()).find(`[aria-label="Copy ${name}"]`)
        expect(button.text()).toBe(label)
        await button.trigger('click')
        await vi.waitFor(() => expect(button.text()).toBe('Copied'))
        expect(writeText).toHaveBeenCalledWith(text)
    })
})
