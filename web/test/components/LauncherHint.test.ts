import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Project} from '#shared/roadmap'
import LauncherHint from '~/components/LauncherHint.vue'

// Getting started's word on the launcher (ORR-426): while none is running for the project it says how to install one,
// and it goes once one connects, heard through the launchers coming and going.
let launchers = 0
registerEndpoint('/api/projects/greenhouse/launches', () => ({launchers, folders: [], every: false, started: 0, starting: 0, total: 0}))

const mounted: VueWrapper[] = []
beforeEach(() => {
    launchers = 0
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', releases: [], board: {chunks: []}} as unknown as Project]
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useState('launch-state').value = {}
})

describe('LauncherHint', () => {
    it('says how to install the launcher while none runs, and goes once one connects', async () => {
        const wrapper = await mountSuspended(LauncherHint, {props: {project: 'greenhouse'}})
        mounted.push(wrapper)
        await vi.waitFor(() => expect(wrapper.text()).toContain('No launcher is running for Greenhouse.'))
        expect(wrapper.text()).toContain('orrery-launcher.mjs --install')
        expect(wrapper.text()).toContain('tmux 3.2')

        launchers = 1
        useRoadmaps().launchers.value = {greenhouse: 1}
        await vi.waitFor(() => expect(wrapper.text()).not.toContain('No launcher'))
    })

    it('says nothing when a launcher is running', async () => {
        launchers = 1
        const wrapper = await mountSuspended(LauncherHint, {props: {project: 'greenhouse'}})
        mounted.push(wrapper)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(wrapper.text()).toBe('')
    })
})
