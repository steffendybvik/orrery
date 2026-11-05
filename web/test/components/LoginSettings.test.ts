import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {LoginRecord} from '#shared/roadmap'
import LoginSettings from '~/components/LoginSettings.vue'

// Signed in, on App settings (ORR-838): each login with End, End every other login once there are two others, and what
// went wrong (ORR-866).
let logins: LoginRecord[] = []
let refuse = false
const ended: string[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/logins/a', {method: 'DELETE', handler: event => {
    if (refuse) {
        setResponseStatus(event, 403)
        return {message: 'Only the owner ends logins'}
    }
    ended.push('a')
    logins = logins.filter(l => l.id !== 'a')
    return {ok: true}
}})
registerEndpoint('/api/logins', {method: 'GET', handler: () => logins})
registerEndpoint('/api/logins', {method: 'DELETE', handler: () => {
    ended.push('others')
    logins = logins.filter(l => l.current)
    return {ok: true}
}})

const login = (over: Partial<LoginRecord>): LoginRecord => ({id: 'x', person: 'skoll', expires_at: '2026-12-01T00:00:00Z', ...over})
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    ended.splice(0)
    refuse = false
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function mount(given: LoginRecord[]) {
    logins = given
    const wrapper = await mountSuspended(LoginSettings)
    mounted.push(wrapper)
    await settle()
    return wrapper
}
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)

describe('Signed in', () => {
    it('lists each login, with End on all but this browser', async () => {
        const wrapper = await mount([
            login({id: 'me', current: true, created_at: '2026-11-01T00:00:00Z'}),
            login({id: 'a', name: 'Phone, signed in by QR code', created_at: '2026-11-02T00:00:00Z', last_used_at: '2026-11-03T00:00:00Z'}),
            login({id: 'b'}),
        ])
        const rows = wrapper.findAll('ul[aria-label="Logins"] > li')
        expect(rows).toHaveLength(3)
        expect(rows[0]!.text()).toContain('this browser')
        expect(rows[0]!.find('button').exists()).toBe(false)
        expect(rows[1]!.text()).toContain('Phone, signed in by QR code')
        expect(rows[1]!.text()).toContain('last used')
        expect(rows[2]!.text()).toContain('Browser')
        expect(rows[2]!.text()).toContain('signed in before orrery kept the date')
        expect(rows[2]!.find('button').attributes('aria-label')).toBe('End Browser, signed in earlier')
        await rows[1]!.find('button').trigger('click')
        await settle()
        expect(ended).toEqual(['a'])
        expect(wrapper.findAll('ul[aria-label="Logins"] > li')).toHaveLength(2)
    })

    it('ends every other login at once, offered only with two or more others', async () => {
        const one = await mount([login({id: 'me', current: true}), login({id: 'a'})])
        expect(button(one, 'End every other login')).toBeUndefined()
        const wrapper = await mount([login({id: 'me', current: true}), login({id: 'a'}), login({id: 'b'})])
        await button(wrapper, 'End every other login')!.trigger('click')
        await settle()
        expect(ended).toEqual(['others'])
        expect(wrapper.findAll('ul[aria-label="Logins"] > li')).toHaveLength(1)
    })

    it('says why an End was refused, and when nothing is signed in', async () => {
        refuse = true
        const wrapper = await mount([login({id: 'me', current: true}), login({id: 'a'})])
        await button(wrapper, 'End')!.trigger('click')
        await settle()
        expect(wrapper.text()).toContain('Only the owner ends logins')
        expect((await mount([])).text()).toContain('Nothing is signed in')
    })
})
