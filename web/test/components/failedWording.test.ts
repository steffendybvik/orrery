import {afterEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {H3Event} from 'h3'
import {setResponseStatus} from 'h3'
import type {Schedule, Session} from '#shared/roadmap'
import SecretSettings from '~/components/SecretSettings.vue'
import LoginSettings from '~/components/LoginSettings.vue'
import PhoneLink from '~/components/PhoneLink.vue'
import AccountSettings from '~/components/AccountSettings.vue'
import SessionMessage from '~/components/SessionMessage.vue'

// What a failure says when orrery gives no reason (ORR-1327): the thing that was being done, never "Couldn't save it"
// for a read, a run or a message.
const down = (event: H3Event) => {
    setResponseStatus(event, 500)
    return {}
}
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
for (const path of ['/api/epics', '/api/releases', '/api/secrets', '/api/logins', '/api/phone', '/api/me']) registerEndpoint(path, {method: 'GET', handler: down})
registerEndpoint('/api/projects/greenhouse/schedules/3/run', {method: 'POST', handler: down})
registerEndpoint('/api/projects/greenhouse/presets', () => [])
registerEndpoint('/api/projects/greenhouse/sessions/s-1/message', {method: 'POST', handler: down})

const READ = "Couldn't read it. Is orrery running?"
const mounted: VueWrapper[] = []
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))
async function mount(component: Parameters<typeof mountSuspended>[0], props: Record<string, unknown> = {}) {
    const wrapper = await mountSuspended(component, {props, attachTo: document.body})
    mounted.push(wrapper as VueWrapper)
    return wrapper
}

describe('a failure with no reason', () => {
    it('reading epics or releases says it could not read them', async () => {
        const epics = useEpics()
        await epics.load()
        expect(epics.failed.value).toBe(READ)
        const releases = useAllReleases()
        await releases.load()
        expect(releases.failed.value).toBe(READ)
    })

    it('running a schedule says it could not run it', async () => {
        await expect(useSchedules().run({id: 3, project: 'greenhouse'} as Schedule)).resolves.toBe("Couldn't run it. Is orrery running?")
    })

    it.each([['secrets', SecretSettings], ['logins', LoginSettings], ['phone links', PhoneLink], ['account', AccountSettings]] as const)(
        'reading the %s says it could not read them', async (_, component) => {
            const wrapper = await mount(component)
            await vi.waitFor(() => expect(wrapper.text()).toContain(READ))
            expect(wrapper.text()).not.toContain("Couldn't save it")
        })

    it('sending a session a message says it could not send it', async () => {
        const wrapper = await mount(SessionMessage, {session: {id: 's-1', name: 'Var', project: 'greenhouse', listening: true} as Session, project: 'greenhouse'})
        await wrapper.get('textarea').setValue('Water the ferns')
        await wrapper.get('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't send it. Is orrery running?"))
    })
})
