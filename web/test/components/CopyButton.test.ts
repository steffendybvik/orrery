import {afterEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import CopyButton from '~/components/CopyButton.vue'

// Copy says Copied with a tick once the text is on the clipboard, and Couldn't copy when the browser won't take it.
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    vi.restoreAllMocks()
})

async function mount() {
    const wrapper = await mountSuspended(CopyButton, {props: {text: 'Jars of **jam**.', name: 'this reply'}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}

describe('CopyButton', () => {
    it('copies its text as given, and says so', async () => {
        const writeText = vi.fn(async () => {})
        vi.stubGlobal('navigator', {...navigator, clipboard: {writeText}})
        const wrapper = await mount()
        expect(wrapper.attributes('aria-label')).toBe('Copy this reply')
        await wrapper.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toBe('Copied'))
        expect(writeText).toHaveBeenCalledWith('Jars of **jam**.')
        vi.unstubAllGlobals()
    })

    it("says it couldn't copy when the browser refuses", async () => {
        vi.stubGlobal('navigator', {...navigator, clipboard: {writeText: async () => { throw new Error('denied') }}})
        const execCommand = document.execCommand
        document.execCommand = () => false
        const wrapper = await mount()
        await wrapper.trigger('click')
        await vi.waitFor(() => expect(wrapper.text()).toBe("Couldn't copy"))
        document.execCommand = execCommand
        vi.unstubAllGlobals()
    })
})
