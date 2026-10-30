import {describe, expect, it} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import SecretSettings from '~/components/SecretSettings.vue'

// App settings → Secrets: a GITHUB_TOKEN typed without api.github.com among its hosts would be ignored by the pull
// request poll, so the form says so while the value is still in it, and adds the host on a click (ORR-632).
registerEndpoint('/api/secrets', () => [])
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))

describe('SecretSettings', () => {
    it('warns about a GITHUB_TOKEN that may not go to api.github.com, and adds the host', async () => {
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
