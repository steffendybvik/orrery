import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import type {Project, Session} from '#shared/roadmap'
import GettingStarted from '~/components/GettingStarted.vue'

// The card on Now: the steps for Claude stay ticked once they were, though the sessions that ticked them have ended,
// so it doesn't come back with the owner's work done.
const KINDS = {proposed: 0, backlog: 0, todo: 1, started: 0, done: 0, canceled: 0}
const project = (assignee?: string) => ({
    id: 'greenhouse', name: 'Greenhouse', key: 'GRE', release_mode: 'none', releases: [], docs: [],
    board: {kinds: KINDS, chunks: [{id: 'beds', title: 'Beds', tasks: [{id: 'GRE-1', title: 'Water the beds', aliases: [], labels: [], tasks: [], column: 'todo', kind: assignee ? 'started' : 'todo', assignee}]}]},
}) as unknown as Project
const session = (listening: boolean) => ({id: 's1', listening}) as unknown as Session

const mounted: VueWrapper[] = []
// As a reload would: the page starts again from what this browser kept.
function reload() {
    mounted.splice(0).forEach(w => w.unmount())
    clearNuxtState('getting-started-seen')
}
beforeEach(() => {
    localStorage.clear()
    useState('owner').value = {name: 'sam', display: 'Sam', named: true}
})
afterEach(() => {
    reload()
    useRoadmaps().sessions.value = {}
})

async function ticked() {
    const wrapper = await mountSuspended(GettingStarted, {props: {card: true}})
    mounted.push(wrapper)
    return wrapper.text().match(/(\d) of 5/)![1]
}

describe('GettingStarted', () => {
    it("counts the steps for Claude done once a session took on work, with none live", async () => {
        useRoadmaps().projects.value = [project('claude')]
        expect(await ticked()).toBe('5')
    })

    it('remembers a session that connected and listened after it ends', async () => {
        useRoadmaps().projects.value = [project()]
        useRoadmaps().sessions.value = {greenhouse: [session(true)]}
        expect(await ticked()).toBe('4')
        useRoadmaps().sessions.value = {}
        reload()
        expect(await ticked()).toBe('4')
    })

    it('ticks nothing for Claude before a session ever said hello', async () => {
        useRoadmaps().projects.value = [project()]
        expect(await ticked()).toBe('2')
    })
})
