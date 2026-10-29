import {afterEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import {defineComponent, h} from 'vue'

// The keys (useHotkeys): ⌘K for the palette, Esc letting go of one thing at a time, keys left alone while typing, and
// g m to My issues (ORR-586).
const Keys = defineComponent({
    setup() {
        useHotkeys()
        return () => h('main', [h('input', {id: 'box'})])
    },
})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useState('palette-open').value = false
    useState('sidebar-open').value = false
    useSelection().clear()
})

async function mount() {
    const wrapper = await mountSuspended(Keys, {attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const press = (key: string, more: KeyboardEventInit = {}, target: EventTarget = window) =>
    target.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...more}))

describe('useHotkeys', () => {
    it('opens and closes the palette with ⌘K or Ctrl-K, even while typing', async () => {
        const wrapper = await mount()
        const palette = useState('palette-open')
        press('k', {metaKey: true})
        expect(palette.value).toBe(true)
        press('K', {ctrlKey: true}, wrapper.find('#box').element)
        expect(palette.value).toBe(false)
    })

    it('lets go of one thing per Esc: the box being typed in, then the ticked issues, then the sidebar', async () => {
        const wrapper = await mount()
        const box = wrapper.find('#box').element as HTMLInputElement
        const selection = useSelection()
        const sidebar = useState('sidebar-open')
        selection.toggle('greenhouse', 'GRE-1')
        sidebar.value = true
        box.focus()
        press('Escape', {}, box)
        expect(document.activeElement).not.toBe(box)
        expect(selection.selected.value).toHaveLength(1)
        press('Escape')
        expect(selection.selected.value).toEqual([])
        expect(sidebar.value).toBe(true)
        press('Escape')
        expect(sidebar.value).toBe(false)
    })

    it('leaves the keys alone while typing, and goes to My issues on g then m', async () => {
        const wrapper = await mount()
        const router = useRouter()
        await router.push('/schedules')
        const box = wrapper.find('#box').element as HTMLInputElement
        box.focus()
        press('g', {}, box)
        press('m', {}, box)
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(router.currentRoute.value.path).not.toBe('/mine')
        box.blur()
        press('g')
        press('m')
        await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/mine'), {timeout: 5000})
    })
})
