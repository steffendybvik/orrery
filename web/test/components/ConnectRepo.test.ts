import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getMethod, readBody, setResponseStatus} from 'h3'
import type {ConnectRequest} from '#shared/connects'
import type {Project} from '#shared/roadmap'
import ConnectRepo from '~/components/ConnectRepo.vue'

// Connect a repo with a click: what each step of a request says, what ticking sends, and every way it can end.
// `connect-repo.spec.ts` walks a good run against a stand-in launcher, and a cancelled one.
let pickers = 1
let current: ConnectRequest | undefined
let sent: {path: string, body: unknown}[] = []
let refusal = ''
const request = (state: ConnectRequest['state'], more: Partial<ConnectRequest> = {}) =>
    ({id: 'c1', state, folder: '/code/shop', host: 'laptop', ...more}) as ConnectRequest
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/connects', async event => {
    if (getMethod(event) === 'GET') return {pickers, current}
    if (refusal) {
        setResponseStatus(event, 409)
        return {message: refusal}
    }
    sent.push({path: '/connects', body: await readBody(event)})
    return current = request('asking', {host: undefined})
})
registerEndpoint('/api/connects/c1', () => current)
registerEndpoint('/api/connects/c1/write', {method: 'POST', handler: async event => {
    sent.push({path: '/write', body: await readBody(event)})
    return current = request('writing')
}})
registerEndpoint('/api/projects', {method: 'POST', handler: async event => {
    sent.push({path: '/projects', body: await readBody(event)})
    return {id: 'made'}
}})

let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
const mount = async () => wrapper = await mountSuspended(ConnectRepo)
const press = (text: string) => wrapper!.findAll('button').find(b => b.text() === text)!.trigger('click')
const button = (text: string) => wrapper!.findAll('button').find(b => b.text() === text)
const said = () => wrapper!.text()

beforeEach(() => {
    pickers = 1
    current = undefined
    sent = []
    refusal = ''
    useRoadmaps().projects.value = [
        {id: 'shop', name: 'Shop', key: 'SHO', board: {chunks: []}},
        {id: 'blog', name: 'Blog', key: 'BLO', board: {chunks: []}},
    ] as unknown as Project[]
})
afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
})

describe('ConnectRepo', () => {
    it('offers the button with a launcher that can do it, and the install line without', async () => {
        await mount()
        await expect.poll(() => button('Connect a repo')?.exists()).toBe(true)
        wrapper!.unmount()

        pickers = 0
        await mount()
        await expect.poll(said).toContain('First, on this machine: install the launcher')
        expect(button('Connect a repo')).toBeUndefined()
    })

    it('asks a launcher, then says which machine to look at', async () => {
        await mount()
        await expect.poll(() => button('Connect a repo')?.exists()).toBe(true)
        await press('Connect a repo')
        await expect.poll(said).toContain('Asking your launcher to open a folder picker')
        expect(sent).toEqual([{path: '/connects', body: {}}])
        current = request('picking')
        await expect.poll(said, {timeout: 3000}).toContain("Choose the repo's folder in the picker on laptop.")
    })

    it('says why it was refused, and stays where it was', async () => {
        await mount()
        await expect.poll(() => button('Connect a repo')?.exists()).toBe(true)
        refusal = 'Another request is under way'
        await press('Connect a repo')
        await expect.poll(said).toContain('Another request is under way')
        expect(button('Connect a repo')).toBeDefined()
    })

    it('picks a request already under way back up, as a reload would', async () => {
        current = request('picked')
        await mount()
        await expect.poll(said).toContain('Which projects does /code/shop hold?')
        expect(said()).toContain('On laptop.')
    })

    it('needs a tick to set it up, and sends what was ticked', async () => {
        current = request('picked')
        await mount()
        await expect.poll(said).toContain('Which projects does')
        expect(button('Set it up')!.attributes('disabled')).toBeDefined()
        await wrapper!.find('input[value="blog"]').setValue(true)
        expect(button('Set it up')!.attributes('disabled')).toBeUndefined()
        await press('Set it up')
        await expect.poll(() => sent).toEqual([{path: '/write', body: {projects: ['blog']}}])
        await expect.poll(said).toContain('Setting up /code/shop')
    })

    it('keeps what is already connected ticked, can set it up with nothing new, and drops a project gone from here', async () => {
        current = request('picked', {projects: ['shop', 'long-gone']})
        await mount()
        await expect.poll(said).toContain('already connected')
        const shop = wrapper!.findAll('label').find(l => l.text().includes('Shop'))!
        expect((shop.find('input').element as HTMLInputElement).disabled).toBe(true)
        await press('Set it up')
        await expect.poll(() => sent).toEqual([{path: '/write', body: {projects: ['shop']}}])
    })

    it('has nothing to tick when its channel serves every project', async () => {
        current = request('picked', {every: true})
        await mount()
        await expect.poll(said).toContain('nothing to tick')
        expect(wrapper!.find('input[type="checkbox"]').exists()).toBe(false)
        expect(button('Set it up')!.attributes('disabled')).toBeUndefined()
    })

    it('makes a new project and ticks it', async () => {
        current = request('picked')
        await mount()
        await expect.poll(said).toContain('Which projects does')
        await wrapper!.find('[aria-label="A new project\'s name"]').setValue('  Made ')
        await wrapper!.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{path: '/projects', body: {name: 'Made'}}])
        await expect.poll(() => button('Set it up')!.attributes('disabled')).toBeUndefined()
        await press('Set it up')
        await expect.poll(() => sent.at(-1)).toEqual({path: '/write', body: {projects: ['made']}})
    })

    it('says what it wrote, and that Claude is open there', async () => {
        current = request('done', {written: ['CLAUDE.md', '.mcp.json'], opened: true})
        await mount()
        await expect.poll(said).toContain('/code/shop is connected')
        expect(said()).toContain('Wrote CLAUDE.md, .mcp.json. Commit them with the repo.')
        expect(said()).toContain('Claude is open in a terminal there')
    })

    it('says when nothing changed, and when it could not open a terminal', async () => {
        current = request('done', {written: [], opened: false})
        await mount()
        await expect.poll(said).toContain('It already had everything, so nothing changed.')
        expect(said()).toContain("Couldn't open a terminal")
    })

    it('says a cancelled picker wrote nothing, and leaves the button to try again', async () => {
        current = request('canceled')
        await mount()
        await expect.poll(said).toContain('Nothing was written: no folder was chosen.')
        expect(button('Connect a repo')).toBeDefined()
    })

    it('says why it failed, and Try again starts over', async () => {
        current = request('failed', {message: "Couldn't write to /code/shop"})
        await mount()
        await expect.poll(() => wrapper!.find('[role="alert"]').exists() && wrapper!.find('[role="alert"]').text()).toBe("Couldn't write to /code/shop")
        current = undefined
        await press('Try again')
        await expect.poll(() => button('Connect a repo')?.exists()).toBe(true)
    })
})
