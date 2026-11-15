import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import AccountSettings from '~/components/AccountSettings.vue'
import type {Account} from '~/components/AccountSettings.vue'

// Account, on App settings (ORR-1203): who you're signed in as, Sign out, and deleting your account, which waits until
// you type your name.
const account: Account = {
    id: 'ana',
    name: 'Ana Lima',
    role: 'member',
    created_at: '2026-11-01T00:00:00Z',
    identities: [{issuer: 'https://accounts.example.com'}],
    workspaces: [
        {id: 'default', name: 'Default', color: null, role: 'member'},
        {id: 'ana-side', name: 'Side projects', color: null, role: 'owner'},
    ],
}
const deleted: unknown[] = []
let loggedOut = 0
let refuse = false
registerEndpoint('/api/me', {method: 'GET', handler: () => account})
registerEndpoint('/api/me', {method: 'DELETE', handler: async event => {
    if (refuse) {
        setResponseStatus(event, 400)
        return {message: 'Type your name, Ana Lima, to delete your account'}
    }
    deleted.push(await readBody(event))
    setResponseStatus(event, 204)
    return null
}})
const spacesDeleted: unknown[] = []
registerEndpoint('/api/workspaces/ana-side', {method: 'DELETE', handler: async event => {
    spacesDeleted.push(await readBody(event))
    setResponseStatus(event, 204)
    return null
}})
registerEndpoint('/api/workspaces', {method: 'GET', handler: () => account.workspaces.filter(w => w.id !== 'ana-side')})
registerEndpoint('/api/auth/logout', {method: 'POST', handler: event => {
    loggedOut++
    setResponseStatus(event, 204)
    return null
}})

const assign = vi.fn()
const mounted: VueWrapper[] = []
beforeEach(() => {
    vi.spyOn(window.location, 'assign').mockImplementation(assign)
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    deleted.splice(0)
    spacesDeleted.splice(0)
    loggedOut = 0
    refuse = false
    assign.mockReset()
    vi.restoreAllMocks()
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function mount() {
    const wrapper = await mountSuspended(AccountSettings)
    mounted.push(wrapper)
    await settle()
    return wrapper
}
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text() === text)!

describe('Account', () => {
    it('shows who you are signed in as, how, since when and your workspaces', async () => {
        const wrapper = await mount()
        const shown = wrapper.find('dl[aria-label="Your account"]').text()
        expect(shown).toContain('Ana Lima')
        expect(shown).toContain('ana')
        expect(shown).toContain('accounts.example.com')
        expect(wrapper.findAll('ul[aria-label="Your workspaces"] > li').map(li => li.text())).toEqual(['Default member', 'Side projects ownerDelete'])
        expect(wrapper.text()).toContain('Goes with it: Side projects')
        expect(wrapper.text()).not.toContain('You own this orrery')
    })

    it('signs out', async () => {
        const wrapper = await mount()
        await button(wrapper, 'Sign out').trigger('click')
        await settle()
        expect(loggedOut).toBe(1)
        expect(assign).toHaveBeenCalledWith('/login')
    })

    it('deletes the account only once your name is typed, any case, then goes to sign in', async () => {
        const wrapper = await mount()
        const remove = button(wrapper, 'Delete my account')
        expect(remove.attributes('disabled')).toBeDefined()
        await wrapper.find('input').setValue('Ana')
        expect(remove.attributes('disabled')).toBeDefined()
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(deleted).toEqual([])
        await wrapper.find('input').setValue('  ana lima ')
        expect(remove.attributes('disabled')).toBeUndefined()
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(deleted).toEqual([{confirm: '  ana lima '}])
        expect(assign).toHaveBeenCalledWith('/login')
    })

    it('says what went wrong, and stays', async () => {
        refuse = true
        const wrapper = await mount()
        await wrapper.find('input').setValue('Ana Lima')
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(wrapper.text()).toContain('Type your name, Ana Lima, to delete your account')
        expect(assign).not.toHaveBeenCalled()
        expect(button(wrapper, 'Delete my account').attributes('disabled')).toBeUndefined()
    })

    it('deletes a workspace you own on its own once its name is typed, and keeps you signed in', async () => {
        const wrapper = await mount()
        // Only one you own, and never the first one: Default, a member's here, has no Delete.
        expect(wrapper.findAll('ul[aria-label="Your workspaces"] button').map(b => b.text())).toEqual(['Delete'])
        await button(wrapper, 'Delete').trigger('click')
        const form = wrapper.find('form[aria-label="Delete Side projects"]')
        const go = button(wrapper, 'Delete workspace')
        expect(go.attributes('disabled')).toBeDefined()
        await form.find('input').setValue('Side')
        await form.trigger('submit')
        await settle()
        expect(spacesDeleted).toEqual([])
        await form.find('input').setValue('side PROJECTS')
        expect(go.attributes('disabled')).toBeUndefined()
        await form.trigger('submit')
        await settle()
        expect(spacesDeleted).toEqual([{confirm: 'side PROJECTS'}])
        expect(deleted).toEqual([])
        expect(wrapper.findAll('ul[aria-label="Your workspaces"] > li').map(li => li.text())).toEqual(['Default member'])
        expect(assign).not.toHaveBeenCalled()
    })

    it('says a name stays off what you leave in other workspaces', async () => {
        const wrapper = await mount()
        expect(wrapper.text()).toContain('“Deleted person”')
        expect(wrapper.text()).not.toContain('your name stays')
    })
})
