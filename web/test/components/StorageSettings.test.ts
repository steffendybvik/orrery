import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, getQuery, setResponseStatus} from 'h3'
import StorageSettings from '~/components/StorageSettings.vue'

// Storage on App settings (ORR-1250): the images nothing shows any more and the room they take, removed by the owner
// with one button, and saying what came free.
let unused = {count: 0, size: 0, uploads: []}
let removing: {actor?: string, unused: unknown}[] = []
let down: 'read' | 'remove' | null = null
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/uploads', {method: 'GET', handler: event => {
    if (down === 'read') {
        setResponseStatus(event, 500)
        return {}
    }
    return getQuery(event).unused === '1' ? unused : []
}})
registerEndpoint('/api/uploads', {method: 'DELETE', handler: event => {
    removing.push({actor: getHeader(event, 'orrery-actor'), unused: getQuery(event).unused})
    if (down === 'remove') {
        setResponseStatus(event, 500)
        return {}
    }
    const was = unused
    unused = {count: 0, size: 0, uploads: []}
    return {count: was.count, size: was.size, compacted: was.size > 1_000_000}
}})

const mounted: VueWrapper[] = []
beforeEach(() => {
    unused = {count: 0, size: 0, uploads: []}
    removing = []
    down = null
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
    useState('people').value = []
    useState('acting').value = null
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount() {
    const wrapper = await mountSuspended(StorageSettings, {attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const cleanUp = (wrapper: VueWrapper) => wrapper.findAll('button').find(b => b.text() === 'Clean up')

describe('StorageSettings', () => {
    it('says every image is shown, and offers nothing to clean up', async () => {
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('Every image here is shown somewhere.'))
        expect(cleanUp(wrapper)).toBeUndefined()
    })

    it('removes the unused ones as the owner, says what came free, and reads them again', async () => {
        unused = {count: 3, size: 2_500_000, uploads: []}
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('3 images nothing shows, taking 2.5 MB.'))
        await cleanUp(wrapper)!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Removed 3 images, 2.5 MB, and gave the room back to the disk.'))
        expect(removing).toEqual([{actor: 'skoll', unused: '1'}])
        expect(wrapper.text()).toContain('Every image here is shown somewhere.')
    })

    it('counts one image as one, and says nothing of the disk when it was not compacted', async () => {
        unused = {count: 1, size: 2_000, uploads: []}
        const wrapper = await mount()
        await vi.waitFor(() => expect(wrapper.text()).toContain('1 image nothing shows, taking 2 KB.'))
        await cleanUp(wrapper)!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Removed 1 image, 2 KB.'))
    })

    it('leaves removing them to the owner when someone else is acting', async () => {
        unused = {count: 2, size: 10, uploads: []}
        useState('people').value = [{id: 'skoll', name: 'Sköll', role: 'owner'}, {id: 'ada', name: 'Ada', role: 'member'}]
        useState('acting').value = 'ada'
        const wrapper = await mount()
        await vi.waitFor(() => expect(cleanUp(wrapper)).toBeDefined())
        expect(cleanUp(wrapper)!.attributes('disabled')).toBeDefined()
        expect(wrapper.text()).toContain("Only this orrery's owner removes images.")
    })

    it("says it couldn't read them, or couldn't remove them", async () => {
        down = 'read'
        const reading = await mount()
        await vi.waitFor(() => expect(reading.text()).toContain("Couldn't read it. Is orrery running?"))
        down = 'remove'
        unused = {count: 1, size: 10, uploads: []}
        const wrapper = await mount()
        await vi.waitFor(() => expect(cleanUp(wrapper)).toBeDefined())
        await cleanUp(wrapper)!.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't remove it. Is orrery running?"))
        expect(cleanUp(wrapper)!.attributes('disabled')).toBeUndefined()
    })
})
