import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Project} from '#shared/roadmap'
import FilterBar from '~/components/FilterBar.vue'

// The Project filter: on the pages across projects (My issues, Now) it narrows them to the projects ticked, a
// project's own pages don't offer it, and Clear unticks it with the rest.
const project = (id: string) => ({id, name: id[0]!.toUpperCase() + id.slice(1), key: id.toUpperCase(), releases: [], board: {chunks: []}}) as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [project('larder'), project('pantry'), project('cellar')]
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useFilters().clear()
})

async function mount(route: string) {
    const wrapper = await mountSuspended(FilterBar, {route, attachTo: document.body})
    mounted.push(wrapper)
    const menu = (label: string) => wrapper.findAll('button[aria-expanded]').find(b => b.text().startsWith(label))
    const button = (text: string) => wrapper.findAll('[role=option], button').find(b => b.text() === text)
    return {wrapper, menu, button}
}

describe('FilterBar', () => {
    it('narrows the pages across projects to the projects ticked, and Clear shows them all again', async () => {
        const {menu, button} = await mount('/mine')
        const {shows, filters} = useFilters()
        expect(['larder', 'pantry', 'cellar'].every(shows)).toBe(true)
        await menu('Project')!.trigger('click')
        await button('Pantry')!.trigger('click')
        expect(filters.value.projects).toEqual(['pantry'])
        expect([shows('larder'), shows('pantry'), shows('cellar')]).toEqual([false, true, false])
        await button('Clear')!.trigger('click')
        expect(filters.value.projects).toEqual([])
        expect(shows('larder')).toBe(true)
    })

    it("isn't offered on a project's own pages", async () => {
        const {menu} = await mount('/p/larder')
        expect(menu('Priority')).toBeDefined()
        expect(menu('Project')).toBeUndefined()
    })
})
