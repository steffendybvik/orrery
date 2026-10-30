import {describe, expect, it} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Secret} from '#shared/roadmap'
import SecretSettings from '~/components/SecretSettings.vue'

// App settings → Secrets (ORR-632): GITHUB_TOKEN listed ready-made until it's set, its form with the name and host fixed;
// once set, a token GitHub turned down said plainly. A GITHUB_TOKEN typed without api.github.com among its hosts would
// be ignored by the pull request poll, so the form says so while the value is still in it, and adds the host on a click.
let listed: Secret[] = []
registerEndpoint('/api/secrets', () => listed)
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))

const github = (status: number) => ({name: 'GITHUB_TOKEN', last4: 'abcd', hosts: ['api.github.com'], projects: null, created_by: 'skoll',
    created_at: '2026-10-30T07:00:00Z', updated_at: '2026-10-30T07:00:00Z',
    last_used: {id: 1, method: 'POST', host: 'api.github.com', path: '/graphql', project: 'shop', issue: null, status, error: null, created_by: 'orrery', created_at: new Date().toISOString()}}) as unknown as Secret

describe('SecretSettings', () => {
    it('lists GITHUB_TOKEN ready-made until it is set, and Set asks only for the token', async () => {
        listed = []
        const wrapper = await mountSuspended(SecretSettings)
        await expect.poll(() => wrapper.text()).toContain('Not set: orrery uses it to read pull requests')
        await wrapper.findAll('button').find(b => b.text() === 'Set')!.trigger('click')
        const name = wrapper.find('input[aria-label="Name"]').element as HTMLInputElement
        const hosts = wrapper.find('input[aria-label="Hosts"]').element as HTMLInputElement
        expect([name.value, name.disabled, hosts.value, hosts.readOnly]).toEqual(['GITHUB_TOKEN', true, 'api.github.com', true])
        expect(wrapper.text()).toContain('Pull requests: Read-only')
        expect(wrapper.find('a[href="https://github.com/settings/personal-access-tokens/new"]').exists()).toBe(true)
        // A secret of the owner's own frees both again.
        await wrapper.findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
        await wrapper.findAll('button').find(b => b.text() === '+ Add a secret')!.trigger('click')
        expect((wrapper.find('input[aria-label="Name"]').element as HTMLInputElement).disabled).toBe(false)
        expect((wrapper.find('input[aria-label="Hosts"]').element as HTMLInputElement).readOnly).toBe(false)
        wrapper.unmount()
    })

    it('drops the ready-made row once set, and says plainly when GitHub turned the token down', async () => {
        listed = [github(401)]
        const wrapper = await mountSuspended(SecretSettings)
        await expect.poll(() => wrapper.text()).toContain('GitHub turned it down')
        expect(wrapper.text()).not.toContain('Not set')
        wrapper.unmount()
        listed = [github(200)]
        const working = await mountSuspended(SecretSettings)
        await expect.poll(() => working.text()).toContain('used')
        expect(working.text()).not.toContain('turned it down')
        working.unmount()
    })

    it('warns about a GITHUB_TOKEN that may not go to api.github.com, and adds the host', async () => {
        listed = []
        const wrapper = await mountSuspended(SecretSettings)
        await wrapper.findAll('button').find(b => b.text() === '+ Add a secret')!.trigger('click')
        const warning = () => wrapper.findAll('p').find(p => p.text().includes('only when it may go to'))
        await wrapper.find('input[aria-label="Name"]').setValue('github_token')
        await wrapper.find('input[aria-label="Hosts"]').setValue('github.com')
        expect(warning()?.text()).toContain('api.github.com')
        await warning()!.findAll('button').find(b => b.text() === 'Add api.github.com')!.trigger('click')
        expect((wrapper.find('input[aria-label="Hosts"]').element as HTMLInputElement).value).toBe('github.com, api.github.com')
        expect(warning()).toBeUndefined()
        // Any other secret goes where it's told, with nothing said.
        await wrapper.find('input[aria-label="Name"]').setValue('STRIPE_KEY')
        await wrapper.find('input[aria-label="Hosts"]').setValue('api.stripe.com')
        expect(warning()).toBeUndefined()
        wrapper.unmount()
    })
})
