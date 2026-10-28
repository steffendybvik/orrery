import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import OwnerDialog from '~/components/OwnerDialog.vue'

// The first open asks whose orrery it is: the id it makes from the name, and what it sends.
let renamed: unknown[] = []
registerEndpoint('/api/owner', {method: 'GET', handler: () => ({name: 'agent', display: '', named: false})})
registerEndpoint('/api/owner', {method: 'PUT', handler: async event => {
    const body = await readBody<{name: string}>(event)
    renamed.push(body)
    return {name: 'skoll_fenrisson', display: body.name, named: true}
}})

const mounted: VueWrapper[] = []
beforeEach(() => {
    renamed = []
    useOwner().owner.value = {name: 'agent', display: '', named: false}
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    mounted.push(await mountSuspended(OwnerDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    const submit = () => wrapper.findAll('button').find(b => b.text().includes('Continue'))!
    return {wrapper, submit}
}

describe('OwnerDialog', () => {
    it('shows the id the name makes, and saves it as the owner', async () => {
        const {wrapper} = await mount()
        await wrapper.find('input').setValue('  Sköll Fenrisson ')
        expect(wrapper.text()).toContain('skoll_fenrisson')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(renamed).toEqual([{name: 'Sköll Fenrisson'}]))
        await vi.waitFor(() => expect(wrapper.find('form').exists()).toBe(false))
    })

    it('won\'t take a blank name or "agent"', async () => {
        const {wrapper, submit} = await mount()
        expect(submit().attributes('disabled')).toBeDefined()
        await wrapper.find('input').setValue('Agent')
        expect(submit().attributes('disabled')).toBeDefined()
        expect(wrapper.text()).toContain('"agent" is what requests without a name are')
        await wrapper.find('form').trigger('submit')
        expect(renamed).toEqual([])
    })
})
