import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Issue, Project} from '#shared/roadmap'
import FilterBar from '~/components/FilterBar.vue'

// The Project filter: on My issues, across projects, it narrows it to the projects ticked, a
// project's own pages don't offer it, and Clear unticks it with the rest. Blocked or Ready (ORR-601) splits the issues
// by whether they wait on others.
const project = (id: string) => ({id, name: id[0]!.toUpperCase() + id.slice(1), key: id.toUpperCase(), releases: [], board: {chunks: []}}) as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [project('greenhouse'), project('pantry'), project('cellar')]
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
        expect(['greenhouse', 'pantry', 'cellar'].every(shows)).toBe(true)
        await menu('Project')!.trigger('click')
        await button('Pantry')!.trigger('click')
        expect(filters.value.projects).toEqual(['pantry'])
        expect([shows('greenhouse'), shows('pantry'), shows('cellar')]).toEqual([false, true, false])
        await button('Clear')!.trigger('click')
        expect(filters.value.projects).toEqual([])
        expect(shows('greenhouse')).toBe(true)
    })

    it('keeps the blocked issues, or the ready ones, and Clear takes it off', async () => {
        const {wrapper, menu} = await mount('/p/greenhouse')
        const {filters, matches, changed} = useFilters()
        const blocked = {id: 'GRE-2', title: 'Fill the jars', labels: [], column: 'todo', blocked_by: ['GRE-1']} as unknown as Issue
        const ready = {id: 'GRE-1', title: 'Label the jars', labels: [], column: 'todo', depends_on: ['GRE-3']} as unknown as Issue
        filters.value.columns = []
        await menu('Blocked')!.trigger('click')
        // The menu's button says Blocked too: the option is the one in the list.
        await wrapper.findAll('[role=option]').find(o => o.text() === 'Blocked')!.trigger('click')
        expect(filters.value.blocked).toEqual(['blocked'])
        expect([matches(blocked), matches(ready)]).toEqual([true, false])
        filters.value.blocked = ['ready']
        expect([matches(blocked), matches(ready)]).toEqual([false, true])
        expect(changed.value).toBe(true)
        useFilters().clear()
        expect(filters.value.blocked).toEqual([])
    })

    it("isn't offered on a project's own pages", async () => {
        const {menu} = await mount('/p/greenhouse')
        expect(menu('Priority')).toBeDefined()
        expect(menu('Project')).toBeUndefined()
    })
})
