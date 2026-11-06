import {afterEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {setResponseStatus} from 'h3'
import type {PhoneLinks} from '#shared/phone'
import PhoneLink from '~/components/PhoneLink.vue'

// Open on your phone (ORR-833): the addresses with a QR code, a one-time sign-in link in it when the phone has a port of
// its own (ORR-837), the `.local` name first (ORR-874), and what to do while only this machine reaches orrery (ORR-866).
let answer: PhoneLinks | 'fail'
let made = 0
// A write goes as the owner, so it asks who that is first.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/phone/link', {method: 'POST', handler: () => {
    made++
    return {token: `t${made}`, code: made === 1 ? 'KQ7M4X' : 'BCD234', expires_at: new Date(Date.now() + 5 * 60_000).toISOString()}
}})
registerEndpoint('/api/phone', {method: 'GET', handler: event => {
    if (answer === 'fail') {
        setResponseStatus(event, 500)
        return {message: 'No network'}
    }
    return answer
}})

const links = (over: Partial<PhoneLinks>): PhoneLinks => ({reach: 'network', docker: true, port: '9010', phone: false, addresses: [], ...over})
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    made = 0
})
async function mount(given: PhoneLinks | 'fail') {
    answer = given
    const wrapper = await mountSuspended(PhoneLink)
    mounted.push(wrapper)
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
    return wrapper
}
const code = (wrapper: VueWrapper) => wrapper.find('[role="img"]')

describe('Open on your phone', () => {
    it('shows each address with where it came from, the first one\'s code, and switches the code on a click', async () => {
        const wrapper = await mount(links({addresses: [
            {url: 'http://mac.local:9010', from: 'machine', name: true},
            {url: 'http://192.168.1.4:9010', from: 'launcher', machine: 'studio'},
            {url: 'https://orrery.example', from: 'setting'},
        ]}))
        expect(code(wrapper).attributes('aria-label')).toBe('QR code for http://mac.local:9010')
        expect(code(wrapper).html()).toContain('<svg')
        expect(wrapper.text()).toContain("from this machine's network")
        expect(wrapper.text()).toContain('from the launcher on studio')
        expect(wrapper.text()).toContain('from ORRERY_PHONE_URL')
        expect(wrapper.text()).toContain("is this machine's name on the Wi-Fi")
        expect(wrapper.text()).toContain('sign in with your person key')
        expect(wrapper.text()).toContain('This is plain http')
        expect(made).toBe(0)
        await wrapper.find('button[aria-label="Show the QR code for https://orrery.example"]').trigger('click')
        expect(code(wrapper).attributes('aria-label')).toBe('QR code for https://orrery.example')
        expect(wrapper.find('button[aria-label="Show the QR code for https://orrery.example"]').attributes('aria-pressed')).toBe('true')
        expect(wrapper.text()).not.toContain("is this machine's name on the Wi-Fi")
        expect(wrapper.text()).not.toContain('This is plain http')
    })

    it('puts a one-time sign-in link in the code when the phone has its own port', async () => {
        // The code without a sign-in link first, so the one with it can be waited for: the token comes back after the
        // POST is answered, and a busy run may draw the code before it does (ORR-898).
        const plain = await mount(links({phone: false, addresses: [{url: 'https://orrery.example', from: 'host'}]}))
        await vi.waitFor(() => expect(code(plain).html()).toContain('<svg'))
        const without = code(plain).html()
        expect(made).toBe(0)
        plain.unmount()
        mounted.pop()
        const wrapper = await mount(links({phone: true, addresses: [{url: 'https://orrery.example', from: 'host'}]}))
        expect(wrapper.text()).toContain("you're signed in, on a login of the phone's own")
        // The code is drawn from the link with the token, so it isn't the plain one.
        await vi.waitFor(() => expect(code(wrapper).html()).not.toBe(without))
        expect(made).toBe(1)
    })

    it('shows a code to type under it when the phone has its own port, and makes a new one on New code (ORR-875)', async () => {
        const wrapper = await mount(links({phone: true, addresses: [{url: 'http://mac.local:19010', from: 'machine', name: true}]}))
        await vi.waitFor(() => expect(wrapper.find('[data-testid="phone-code"]').text()).toBe('KQ7-M4X'))
        expect(wrapper.text()).toContain('added to the home screen')
        await wrapper.findAll('button').find(b => b.text() === 'New code')!.trigger('click')
        await vi.waitFor(() => expect(wrapper.find('[data-testid="phone-code"]').text()).toBe('BCD-234'))
        expect(made).toBe(2)
        const plain = await mount(links({phone: false, addresses: [{url: 'https://orrery.example', from: 'host'}]}))
        expect(plain.find('[data-testid="phone-code"]').exists()).toBe(false)
    })

    it('says how to reach it when orrery can\'t see the machine\'s address from its container', async () => {
        const wrapper = await mount(links({port: '9020'}))
        expect(wrapper.text()).toContain("it can't see this machine's address from inside its container")
        expect(wrapper.text()).toContain('ORRERY_PHONE_URL=http://<address>:9020')
    })

    it('says how to open it up while only this machine reaches it', async () => {
        const local = await mount(links({reach: 'loopback'}))
        expect(local.text()).toContain('Only this machine can open it now')
        expect(local.find('a[href="/p/orrery/docs/running#reach-it-from-your-phone"]').exists()).toBe(true)
        const loopbackPhone = await mount(links({reach: 'loopback', phone: true}))
        expect(loopbackPhone.text()).toContain('ORRERY_PHONE_HOST')
        expect(made).toBe(0)
    })

    it('says why it couldn\'t ask', async () => {
        expect((await mount('fail')).text()).toContain('No network')
    })
})
