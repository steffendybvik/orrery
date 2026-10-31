import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Project, Session} from '#shared/roadmap'
import CommandPalette from '~/components/CommandPalette.vue'
import {mostUsedCommands, recordCommand} from '~/utils/commandUse'

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
    useRoadmaps().sessions.value = {}
    localStorage.clear()
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

const runs = (key: string, times: number, at = Date.now()) => {
    for (let n = 0; n < times; n++) recordCommand(key, at)
}
const DAY = 86_400_000

describe('CommandPalette', () => {
    describe('Most used (ORR-782)', () => {
        const used = (wrapper: DOMWrapper<Element>) => wrapper.find('section[aria-label="Most used"]').findAll('[role="option"]').map(o => o.text())

        it('stays out until a command has been run a few times', async () => {
            runs('go:sessions', 2)
            const {sections} = await mount()
            expect(sections()).toEqual(['Jump to', 'Go to'])
        })

        it('leads with the most used, chosen first, and repeats none of them below', async () => {
            runs('go:events', 3)
            runs('go:sessions', 5)
            const {sections, chosen, wrapper} = await mount()
            expect(sections()).toEqual(['Most used', 'Jump to', 'Go to'])
            expect(used(wrapper)[0]).toContain('Sessions')
            expect(used(wrapper)[1]).toContain('Events')
            expect(chosen()).toContain('Sessions')
            const go = wrapper.find('section[aria-label="Go to"]').text()
            expect(go).not.toContain('Sessions')
            expect(go).not.toContain('Events')
            expect(go).toContain('Schedules')
        })

        it('counts older use for less, so it follows changing habits', async () => {
            runs('go:events', 6, Date.now() - 28 * DAY)
            runs('go:sessions', 4)
            const {wrapper} = await mount()
            expect(used(wrapper)[0]).toContain('Sessions')
            expect(mostUsedCommands(Date.now() + 28 * DAY)).toEqual([])
        })

        it('shows five at most, and only what this page offers', async () => {
            runs('group:chunk', 9)
            for (const key of ['go:mine', 'go:connect', 'go:sessions', 'go:schedules', 'go:releases', 'go:events']) runs(key, 3)
            const {sections, wrapper} = await mount()
            expect(sections()[0]).toBe('Most used')
            expect(used(wrapper)).toHaveLength(5)
            expect(used(wrapper).join()).not.toContain('Group the list')
        })

        it('holds its order while open, and hides from a search', async () => {
            runs('go:events', 3)
            const {input, sections, wrapper} = await mount()
            runs('go:sessions', 9)
            await input().setValue('x')
            await input().setValue('')
            expect(used(wrapper)).toHaveLength(1)
            expect(used(wrapper)[0]).toContain('Events')
            await input().setValue('events')
            expect(sections()).not.toContain('Most used')
        })

        it('counts a command as it runs, and not a place', async () => {
            const {input, key} = await mount()
            for (let n = 0; n < 3; n++) {
                await input().setValue('>schedules')
                useState('palette-open').value = true
                await key('Enter')
                useState('palette-open').value = true
                await nextTick()
            }
            expect(mostUsedCommands()).toEqual(['go:schedules'])
            for (let n = 0; n < 3; n++) {
                await input().setValue('@pantry')
                await key('Enter')
                useState('palette-open').value = true
                await nextTick()
            }
            expect(mostUsedCommands()).toEqual(['go:schedules'])
        })
    })

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

    it('starts a session on the project of the page, and offers nothing to message with nobody listening (ORR-679)', async () => {
        const {input, key, wrapper} = await mount()
        await input().setValue('>start session')
        expect(wrapper.text()).not.toContain('Start session')
        useRoadmaps().projects.value = [{...GREENHOUSE, starts: true}, PANTRY]
        await nextTick()
        await input().setValue('>session')
        expect(wrapper.text()).toContain('Start session')
        expect(wrapper.text()).not.toContain('Message sessions')
        await input().setValue('>start session')
        await key('Enter')
        expect(useStartSession().target.value).toEqual({project: null})
        useStartSession().close()
    })

    it('messages every session, or one found by name, once each and only those listening (ORR-679)', async () => {
        const shelves = {id: 's1', name: 'kitchen shelves', project: 'greenhouse', also: ['pantry'], listening: true} as unknown as Session
        const deaf = {id: 's2', name: 'cellar door', project: 'pantry', listening: false} as unknown as Session
        useRoadmaps().sessions.value = {greenhouse: [shelves], pantry: [shelves, deaf]}
        const {input, key, wrapper} = await mount()
        await input().setValue('>message')
        expect(wrapper.text()).toContain('Message sessions')
        expect(wrapper.findAll('[role="option"]').filter(o => o.text().includes('kitchen shelves'))).toHaveLength(1)
        expect(wrapper.text()).not.toContain('cellar door')

        await input().setValue('>kitchen')
        await key('Enter')
        const {one, all} = useMessageSessions()
        expect(one.value?.id).toBe('s1')
        one.value = null

        useState('palette-open').value = true
        await nextTick()
        await input().setValue('>message sessions')
        await key('Enter')
        expect(all.value).toBe(true)
        all.value = false
    })
})
