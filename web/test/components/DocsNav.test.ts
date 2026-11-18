import {afterEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project} from '#shared/roadmap'
import DocsNav from '~/components/DocsNav.vue'

// A section header moved by ⌥↑/⌥↓ keeps focus however often the list redraws after (ORR-767, ORR-1299): the server's
// order, or a late one from an earlier move, moves its node again, which drops focus to the page.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/shelves/doc-sections/Gamma', {method: 'PATCH', handler: () => ({})})

const project = (sections: string[]) => ({id: 'shelves', name: 'Shelves', key: 'SHE', docs: [], doc_sections: sections}) as unknown as Project
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})

async function mount() {
    const wrapper = await mountSuspended(DocsNav, {props: {project: project(['Alpha', 'Beta', 'Gamma'])}, route: '/p/shelves/docs', attachTo: document.body})
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
const header = (wrapper: VueWrapper, name: string) => wrapper.find(`section[aria-label="${name}"] [role="button"]`).element as HTMLElement
const shown = (wrapper: VueWrapper) => wrapper.findAll('section').map(s => s.attributes('aria-label'))

describe('moving a section by the keys', () => {
    it('keeps its header focused when the list redraws after the move', async () => {
        const wrapper = await mount()
        header(wrapper, 'Gamma').focus()
        header(wrapper, 'Gamma').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', altKey: true, bubbles: true}))
        await flushPromises()
        expect(shown(wrapper)).toEqual(['Alpha', 'Gamma', 'Beta'])

        // A late order from an earlier move redraws it, and its node loses focus as it moves; then the server's own.
        for (const sections of [['Gamma', 'Alpha', 'Beta'], ['Alpha', 'Gamma', 'Beta']]) {
            ;(document.activeElement as HTMLElement).blur()
            await wrapper.setProps({project: project(sections)})
            await flushPromises()
            await vi.waitFor(() => expect(document.activeElement).toBe(header(wrapper, 'Gamma')))
        }
    })

    it('lets go once something else is clicked', async () => {
        const wrapper = await mount()
        header(wrapper, 'Gamma').focus()
        header(wrapper, 'Gamma').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', altKey: true, bubbles: true}))
        await flushPromises()
        window.dispatchEvent(new PointerEvent('pointerdown'))
        ;(document.activeElement as HTMLElement).blur()
        await wrapper.setProps({project: project(['Gamma', 'Alpha', 'Beta'])})
        await flushPromises()
        expect(document.activeElement).toBe(document.body)
    })
})
