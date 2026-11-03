import {afterEach, describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import {defineComponent, h} from 'vue'
import UiSplitter from '../../app/components/ui/Splitter.vue'

// The border between two panes (UiSplitter) and the width it remembers (usePaneWidth): dragged, nudged by keys, held
// between its ends, reset by a double-click and kept in this browser (ORR-820).
const KEY = 'test-pane-width'

/** A list, the splitter and a pane after it, in a row 1000 px wide. */
const Split = defineComponent({
    setup() {
        const {width, initial} = usePaneWidth(KEY, 400)
        return () => h('div', {'data-row': ''}, [
            h('div', {'data-list': '', 'style': {width: `${width.value}px`}}),
            h(UiSplitter, {'modelValue': width.value, 'onUpdate:modelValue': (to: number) => width.value = to, initial, 'min': 240, 'keep': 320, 'label': 'Resize the list'}),
            h('div'),
        ])
    },
})

async function mount() {
    const split = await mountSuspended(Split)
    const row = split.find('[data-row]').element as HTMLElement
    Object.defineProperty(row, 'clientWidth', {value: 1000, configurable: true})
    const list = split.find('[data-list]').element as HTMLElement
    list.getBoundingClientRect = () => ({width: Number.parseFloat(list.style.width)}) as DOMRect
    const handle = split.find('[role="separator"]')
    ;(handle.element as HTMLElement).setPointerCapture = () => {}
    ;(handle.element as HTMLElement).releasePointerCapture = () => {}
    return {split, handle, width: () => Number(handle.attributes('aria-valuenow'))}
}
const pointer = (type: string, clientX: number) => new PointerEvent(type, {clientX, button: 0, pointerId: 1, bubbles: true})

afterEach(() => {
    localStorage.removeItem(KEY)
    clearNuxtState(`pane-width:${KEY}`)
})

describe('UiSplitter', () => {
    it('is a focusable, labelled vertical separator', async () => {
        const {handle} = await mount()
        expect(handle.attributes('aria-orientation')).toBe('vertical')
        expect(handle.attributes('aria-label')).toBe('Resize the list')
        expect(handle.attributes('tabindex')).toBe('0')
        expect(handle.attributes('aria-valuenow')).toBe('400')
    })

    it('follows a drag, held between its least and what leaves the other pane room', async () => {
        const {handle, width} = await mount()
        const el = handle.element
        el.dispatchEvent(pointer('pointerdown', 500))
        el.dispatchEvent(pointer('pointermove', 600))
        await nextTick()
        expect(width()).toBe(500)
        expect(document.documentElement.classList.contains('cursor-col-resize')).toBe(true)
        el.dispatchEvent(pointer('pointermove', 2000))
        await nextTick()
        expect(width()).toBe(1000 - 320)
        el.dispatchEvent(pointer('pointermove', 0))
        await nextTick()
        expect(width()).toBe(240)
        el.dispatchEvent(pointer('pointerup', 0))
        await nextTick()
        expect(document.documentElement.classList.contains('cursor-col-resize')).toBe(false)
    })

    it('moves by the arrows, more with Shift, and to its ends with Home and End', async () => {
        const {handle, width} = await mount()
        await handle.trigger('keydown', {key: 'ArrowRight'})
        expect(width()).toBe(416)
        await handle.trigger('keydown', {key: 'ArrowLeft', shiftKey: true})
        expect(width()).toBe(352)
        await handle.trigger('keydown', {key: 'End'})
        expect(width()).toBe(680)
        await handle.trigger('keydown', {key: 'Home'})
        expect(width()).toBe(240)
    })

    it('remembers the width, and a double-click puts it back and forgets it', async () => {
        const {handle} = await mount()
        await handle.trigger('keydown', {key: 'ArrowRight'})
        expect(localStorage.getItem(KEY)).toBe('416')
        await handle.trigger('dblclick')
        expect(handle.attributes('aria-valuenow')).toBe('400')
        expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('starts at the width it remembered', async () => {
        localStorage.setItem(KEY, '520')
        const {width} = await mount()
        expect(width()).toBe(520)
    })
})
