import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Project} from '#shared/roadmap'
import CommandPalette from '~/components/CommandPalette.vue'

// ⌘K's keyboard: what it shows with nothing typed, an exact id as the Top hit, ↑↓ round the ends, ⇥ by section, a scope
// prefix, "N more" opening on ↵, and ↵ running the row in focus.
const KINDS = {proposed: 0, backlog: 0, todo: 8, started: 0, done: 0, canceled: 0}
const issue = (id: string, title: string, aliases: string[] = []) => ({id, title, aliases, labels: [], tasks: [], column: 'todo', kind: 'todo'})
const project = (id: string, name: string, issues: ReturnType<typeof issue>[]) => ({
    id, name, key: id.toUpperCase(), release_mode: 'none', releases: [], docs: [{id: 'shelving', title: `${name} shelving guide`}],
    board: {kinds: KINDS, chunks: [{id: 'stock', title: `${name} stock`, tasks: issues}]},
}) as unknown as Project
const GREENHOUSE = project('greenhouse', 'Greenhouse', Array.from({length: 8}, (_, n) => issue(`GRE-${n + 1}`, `Label jar ${n + 1}`, n === 0 ? ['OLD-9'] : [])))
const PANTRY = project('pantry', 'Pantry', [issue('PAN-1', 'Sort the tins')])

const mounted: VueWrapper[] = []
beforeEach(() => {
    useRoadmaps().projects.value = [GREENHOUSE, PANTRY]
    useState('palette-open').value = true
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useState('palette-open').value = false
})

async function mount() {
    mounted.push(await mountSuspended(CommandPalette, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const input = () => wrapper.find('input[aria-label="Type a command or search"]')
    const key = (k: string, more: Record<string, unknown> = {}) => input().trigger('keydown', {key: k, ...more})
    const sections = () => wrapper.findAll('section').map(s => s.attributes('aria-label'))
    const chosen = () => wrapper.find('[aria-selected="true"]').text()
    return {wrapper, input, key, sections, chosen}
}

describe('CommandPalette', () => {
    it('offers the projects and places with nothing typed', async () => {
        const {sections, wrapper} = await mount()
        expect(sections()).toEqual(['Jump to', 'Go to'])
        const jump = wrapper.find('section[aria-label="Jump to"]').text()
        expect(jump).toContain('Greenhouse')
        expect(jump).toContain('Pantry')
    })

    it('puts an exact id first, by an id it had too', async () => {
        const {input, sections, chosen} = await mount()
        await input().setValue('pan-1')
        expect(sections()[0]).toBe('Top hit')
        expect(chosen()).toContain('Sort the tins')
        await input().setValue('old-9')
        expect(chosen()).toContain('Label jar 1')
    })

    it('points a screen reader at the row ↑↓ are on', async () => {
        const {wrapper, input, key} = await mount()
        const lit = () => wrapper.find(`#${input().attributes('aria-activedescendant')}`)
        expect(input().attributes('role')).toBe('combobox')
        expect(lit().attributes('aria-selected')).toBe('true')
        const first = lit().text()
        await key('ArrowDown')
        expect(lit().attributes('aria-selected')).toBe('true')
        expect(lit().text()).not.toBe(first)
    })

    it('moves with ↑↓ round the ends, and ⇥ to the next section', async () => {
        const {input, key, chosen} = await mount()
        await input().setValue('greenhouse')
        const first = chosen()
        await key('ArrowUp')
        const last = chosen()
        expect(last).not.toBe(first)
        await key('ArrowDown')
        expect(chosen()).toBe(first)
        await key('Tab')
        expect(chosen()).toContain('Label jar')
        await key('Tab', {shiftKey: true})
        expect(chosen()).toBe(first)
    })

    it('narrows to issues with #, and opens the rest past "N more" on ↵', async () => {
        const {wrapper, input, key, sections} = await mount()
        await input().setValue('#jar')
        expect(sections()).toEqual(['Issues'])
        await input().setValue('jar')
        expect(wrapper.find('section[aria-label="Issues"]').text()).toContain('2 more…')
        for (let i = 0; i < 6; i++) await key('ArrowDown')
        await key('Enter')
        expect(wrapper.find('section[aria-label="Issues"]').findAll('[role="option"]')).toHaveLength(8)
    })

    it('runs the row in focus on ↵, and closes; Esc closes too', async () => {
        const {input, key} = await mount()
        await input().setValue('gre-3')
        await key('Enter')
        // The issue's page is built the first time it's gone to, which a busy machine takes well over a second for.
        await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/p/greenhouse/issues/GRE-3'), {timeout: 5000})
        expect(useState('palette-open').value).toBe(false)
        useState('palette-open').value = true
        await vi.waitFor(() => expect(input().exists()).toBe(true))
        await key('Escape')
        expect(useState('palette-open').value).toBe(false)
    })
})
