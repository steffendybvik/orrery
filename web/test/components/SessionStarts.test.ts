import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Schedule, Settings} from '#shared/roadmap'
import SessionStarts from '~/components/SessionStarts.vue'

// Let orrery start sessions, on the Sessions page: the opt-in, its limits, starting one when work finds nobody
// listening, and how many schedules start sessions (ORR-866).
const saved: Partial<Settings>[] = []
let refuse = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/settings', {method: 'PATCH', handler: async event => {
    if (refuse) {
        setResponseStatus(event, 400)
        return {message: 'limit must be 1 to 20'}
    }
    const change = await readBody<Partial<Settings>>(event)
    saved.push(change)
    return {...useAppSettings().settings.value, ...change}
}})

const schedule = (over: Partial<Schedule>) => ({id: 1, project: 'shop', enabled: true, kind: 'message', ...over}) as Schedule
const mounted: VueWrapper[] = []
beforeEach(() => {
    clearNuxtState(['app-settings', 'app-settings-saving', 'app-settings-latest', 'schedules'])
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    saved.splice(0)
    refuse = false
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function mount(starts: Settings['starts'], schedules: Schedule[] = []) {
    useAppSettings().settings.value = {...useAppSettings().settings.value, starts}
    useSchedules().byProject.value = {shop: schedules}
    const wrapper = await mountSuspended(SessionStarts)
    mounted.push(wrapper)
    return wrapper
}
const box = (wrapper: VueWrapper, label: string) => wrapper.findAll('label').find(l => l.text().includes(label))!.find('input')

describe('Let orrery start sessions', () => {
    it('turns on with one at once, and off again', async () => {
        const wrapper = await mount(null)
        expect(wrapper.find('input[aria-label="Sessions at once"]').attributes('disabled')).toBeDefined()
        await box(wrapper, 'Let orrery start sessions').setValue(true)
        await settle()
        expect(saved).toEqual([{starts: {limit: 1}}])
        expect(wrapper.find('input[aria-label="Sessions at once"]').attributes('disabled')).toBeUndefined()
        await box(wrapper, 'Let orrery start sessions').setValue(false)
        await settle()
        expect(saved[1]).toEqual({starts: null})
    })

    it('saves its limits, taking a minimum above the limit down to it', async () => {
        const wrapper = await mount({limit: 3, min: 2})
        expect((wrapper.find('input[aria-label="Sessions at once"]').element as HTMLInputElement).value).toBe('3')
        await wrapper.find('input[aria-label="Minutes each"]').setValue('60')
        await wrapper.find('input[aria-label="Minutes each"]').trigger('change')
        await settle()
        expect(saved.at(-1)).toEqual({starts: {limit: 3, min: 2, minutes: 60}})
        await wrapper.find('input[aria-label="Sessions at once"]').setValue('1')
        await wrapper.find('input[aria-label="Sessions at once"]').trigger('change')
        await settle()
        expect(saved.at(-1)).toEqual({starts: {limit: 1, min: 1, minutes: 60}})
    })

    it('counts the schedules that start sessions, less the ones that only do when work finds nobody listening', async () => {
        const schedules = [
            schedule({id: 1, kind: 'session'}),
            schedule({id: 2, kind: 'message'}),
            schedule({id: 3, kind: 'issue', ask: true} as Partial<Schedule>),
            schedule({id: 4, kind: 'issue'}),
            schedule({id: 5, kind: 'session', enabled: false}),
        ]
        const wrapper = await mount({limit: 2}, schedules)
        expect(wrapper.find('a[href="/schedules"]').text()).toBe('3 do')
        expect(wrapper.text()).toContain("when work reaches a project nobody's listening on")
        await box(wrapper, "nobody's listening").setValue(false)
        await settle()
        expect(saved.at(-1)).toEqual({starts: {limit: 2, on_signal: false}})
        expect(wrapper.find('a[href="/schedules"]').text()).toBe('1 does')
        expect(wrapper.text()).toContain('when you press Start session or Focus on this')
    })

    it('says why a save was refused', async () => {
        refuse = true
        const wrapper = await mount(null)
        await box(wrapper, 'Let orrery start sessions').setValue(true)
        await settle()
        expect(wrapper.text()).toContain('limit must be 1 to 20')
    })
})
