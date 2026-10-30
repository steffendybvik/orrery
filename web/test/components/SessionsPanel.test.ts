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
    useRoadmaps().sessions.value = {greenhouse: [{id: 'a', name: 'a', listening: true}, {id: 'b', name: 'b', listening: true}] as never}
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

    it("sends a chunk to every session", async () => {
        const wrapper = await mount({chunk: '3'})
        await all(wrapper)!.trigger('click')
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]).toMatchObject({on: 'chunk', body: {session: '*'}})
    })
})
