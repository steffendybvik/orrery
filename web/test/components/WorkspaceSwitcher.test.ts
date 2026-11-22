import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import WorkspaceSwitcher from '~/components/WorkspaceSwitcher.vue'
import {welcomeKey, workspaceColor} from '~/composables/useWorkspaces'

// The workspace this tab is in, at the top of the sidebar (ORR-1108): its colour and name, the others you're in to
// open in this tab, and New workspace, which makes one with you its owner and opens it.
const workspaces = [
    {id: 'default', name: 'Home', color: 'teal', role: 'owner'},
    {id: 'work', name: 'Work', color: '#123456', role: 'member'},
]
let made: unknown[] = []
let refuse = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/workspaces', {method: 'GET', handler: () => workspaces})
registerEndpoint('/api/workspaces', {method: 'POST', handler: async event => {
    const body = await readBody<{name: string, color?: string}>(event)
    made.push(body)
    if (refuse) {
        setResponseStatus(event, 409)
        return {statusCode: 409, message: 'A workspace with that name exists'}
    }
    return {id: 'garden', name: body.name, color: body.color ?? null, role: 'owner'}
}})

const mounted: VueWrapper[] = []
let assign: ReturnType<typeof vi.fn>
beforeEach(() => {
    made = []
    refuse = false
    useState('workspaces').value = []
    useState('workspaces-loaded').value = false
    localStorage.clear()
    assign = vi.fn()
    vi.spyOn(window.location, 'assign').mockImplementation(assign)
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.restoreAllMocks()
})

async function mount(route = '/mine') {
    await useRouter().push(route)
    const wrapper = await mountSuspended(WorkspaceSwitcher, {route, attachTo: document.body})
    mounted.push(wrapper)
    await vi.waitFor(() => expect(useState('workspaces-loaded').value).toBe(true))
    await flushPromises()
    return wrapper
}
async function open(wrapper: VueWrapper) {
    await wrapper.get('button').trigger('click')
    await flushPromises()
    return [...document.querySelectorAll<HTMLElement>('[role="menu"] button, [role="menuitem"]')]
}
const item = (items: HTMLElement[], text: string) => items.find(i => i.textContent?.includes(text))!

describe('workspaceColor', () => {
    it('gives a named tint as its colour, a hex as itself, and none as none', () => {
        expect(workspaceColor('teal')).toMatch(/^#|^oklch|^rgb/)
        expect(workspaceColor('#123456')).toBe('#123456')
        expect(workspaceColor(null)).toBeNull()
        expect(welcomeKey('work')).toBe('orrery-welcome:work')
    })
})

describe('WorkspaceSwitcher', () => {
    it("names the tab's workspace, the default when the address names none", async () => {
        const wrapper = await mount()
        expect(wrapper.get('button').text()).toBe('Home')
        expect(wrapper.get('button').attributes('title')).toContain('This tab is in Home')
    })

    it('makes a new one with its name and colour, skips its welcome and opens it', async () => {
        const wrapper = await mount()
        item(await open(wrapper), 'New workspace').click()
        await flushPromises()
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
        const make = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Make it')!
        expect(make.disabled).toBe(true)
        const name = dialog.querySelector<HTMLInputElement>('[data-testid="workspace-name"]')!
        name.value = '  Garden  '
        name.dispatchEvent(new Event('input'))
        const teal = dialog.querySelector<HTMLButtonElement>('button[aria-label="teal"]')!
        teal.click()
        teal.click()
        dialog.querySelector<HTMLButtonElement>('button[aria-label="rose"]')!.click()
        await flushPromises()
        expect(dialog.querySelector('button[aria-label="rose"]')!.getAttribute('aria-pressed')).toBe('true')
        make.click()
        await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
        expect(made).toEqual([{name: 'Garden', color: 'rose'}])
        expect(localStorage.getItem('orrery-welcome:garden')).toBe('done')
        expect(String(assign.mock.calls[0]![0])).toContain('/w/garden/')
    })

    it('says why it could not make one, and lets you try again', async () => {
        refuse = true
        const wrapper = await mount()
        item(await open(wrapper), 'New workspace').click()
        await flushPromises()
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
        const name = dialog.querySelector<HTMLInputElement>('[data-testid="workspace-name"]')!
        name.value = 'Home'
        name.dispatchEvent(new Event('input'))
        await flushPromises()
        const make = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Make it')!
        make.click()
        await vi.waitFor(() => expect(dialog.textContent).toContain('A workspace with that name exists'))
        expect(made).toEqual([{name: 'Home'}])
        expect(assign).not.toHaveBeenCalled()
        expect(make.disabled).toBe(false)
    })
    // Last: the test router stays at a workspace's address once it has been to one. (It puts one in every address,
    // so the fallback for an address with none, your first workspace by id, isn't reached here.)
    it('names the one in the address, and opens another in this tab', async () => {
        const wrapper = await mount('/w/work/mine')
        expect(wrapper.get('button').text()).toBe('Work')
        const items = await open(wrapper)
        expect(item(items, 'Home').textContent).toContain('owner')
        item(items, 'Work').click()
        expect(assign).not.toHaveBeenCalled()
        item(await open(wrapper), 'Home').click()
        expect(assign).toHaveBeenCalledTimes(1)
        expect(String(assign.mock.calls[0]![0])).toMatch(/\/mine$/)
    })
})
