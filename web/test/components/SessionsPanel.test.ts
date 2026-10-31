import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import type {Project} from '#shared/roadmap'
import SessionsPanel from '~/components/SessionsPanel.vue'

// Only a chunk can go to every session (ORR-681): an issue's panel doesn't offer it, and a chunk's button reaches them all.
let sent: {on: string, body: unknown}[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const record = (on: string) => async (event: Parameters<typeof readBody>[0]) => {
    sent.push({on, body: await readBody(event)})
    return {signal: {id: sent.length, project: 'greenhouse', kind: 'focus', target: '*', delivered_to: [], created_by: 'skoll', created_at: '2026-10-30T12:00:00.000Z'}, listeners: 2}
}
registerEndpoint('/api/projects/greenhouse/issues/GRE-1/focus', {method: 'POST', handler: record('issue')})
registerEndpoint('/api/projects/greenhouse/chunks/3/focus', {method: 'POST', handler: record('chunk')})
registerEndpoint('/api/projects/greenhouse/signals', () => [])

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', releases: [], board: {chunks: []}} as unknown as Project]
    useRoadmaps().sessions.value = {greenhouse: [{id: 'a', name: 'a', listening: true, state: 'idle'}, {id: 'b', name: 'b', listening: true, state: 'idle'}] as never}
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})

async function mount(props: {issue?: string, chunk?: string}) {
    const wrapper = await mountSuspended(SessionsPanel, {props: {project: 'greenhouse', ...props}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const all = (wrapper: VueWrapper) => wrapper.findAll('button').find(b => b.text() === 'Focus all on this')

describe('the sessions panel', () => {
    it("doesn't offer an issue to every session", async () => {
        const wrapper = await mount({issue: 'GRE-1'})
        expect(wrapper.findAll('button').map(b => b.text())).toContain('Focus on this')
        expect(all(wrapper)).toBeUndefined()
    })

    describe('on an issue, the sessions it can go to now (ORR-790)', () => {
        const session = (id: string, state: string) => ({id, name: `name-${id}`, listening: true, state})
        const named = (wrapper: VueWrapper) => wrapper.findAll('a').map(a => a.text())
        const row = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)
        const given = (...sessions: object[]) => useRoadmaps().sessions.value = {greenhouse: sessions} as never

        it('lists the idle ones and the one on the issue, with the rest behind a closed row', async () => {
            given(session('free', 'idle'), session('on', 'working'), session('working', 'working'), session('waiting', 'waiting'))
            const wrapper = await mountSuspended(SessionsPanel, {props: {project: 'greenhouse', issue: 'GRE-1', worker: 'on'}})
            mounted.push(wrapper)
            expect(named(wrapper)).toEqual(['name-on', 'name-free'])
            expect(row(wrapper, '2 busy')!.attributes('aria-expanded')).toBe('false')
            expect(wrapper.text()).toContain('4 listening')
        })

        it('opens to the same rows, a waiting session still in rose and each able to take the focus', async () => {
            given(session('waiting', 'waiting'))
            const wrapper = await mount({issue: 'GRE-1'})
            await row(wrapper, '1 busy')!.trigger('click')
            expect(named(wrapper)).toEqual(['name-waiting'])
            expect(wrapper.find('.text-rose-700').exists()).toBe(true)
            await row(wrapper, 'Focus on this')!.trigger('click')
            await vi.waitFor(() => expect(sent).toHaveLength(1))
            expect(sent[0]).toMatchObject({on: 'issue', body: {session: 'waiting'}})
        })

        it('shows only the row when none is free, and stays open as sessions move', async () => {
            given(session('one', 'working'), session('two', 'working'))
            const wrapper = await mount({issue: 'GRE-1'})
            expect(named(wrapper)).toEqual([])
            await row(wrapper, '2 busy')!.trigger('click')
            given(session('one', 'idle'), session('two', 'working'))
            await nextTick()
            expect(row(wrapper, '1 busy')!.attributes('aria-expanded')).toBe('true')
            expect(named(wrapper)).toEqual(['name-one', 'name-two'])
        })

        it('leaves no row when every one is free', async () => {
            const wrapper = await mount({issue: 'GRE-1'})
            expect(wrapper.text()).not.toContain('busy')
        })

        it("lists them all on a chunk's page", async () => {
            given(session('one', 'working'), session('two', 'waiting'))
            const wrapper = await mount({chunk: '3'})
            expect(named(wrapper)).toEqual(['name-one', 'name-two'])
            expect(wrapper.text()).not.toContain('busy')
        })
    })

    it("sends a chunk to every session", async () => {
        const wrapper = await mount({chunk: '3'})
        await all(wrapper)!.trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({on: 'chunk', body: {session: '*'}})
    })
})
