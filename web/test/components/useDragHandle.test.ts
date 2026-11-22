import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import {isControl, useDragHandle} from '~/composables/useDragHandle'

// A header that moves its window (ORR-939, ORR-1126): a press becomes a drag once the pointer has gone a few pixels,
// so a click stays a click; its controls stay theirs; and a link dragged from doesn't open.
const box = {left: 10, top: 20, width: 300, height: 200} as DOMRect
const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    document.body.innerHTML = ''
})

async function mount(enabled = true, rect: DOMRect | null = box) {
    const to = vi.fn()
    let api!: ReturnType<typeof useDragHandle>
    const Host = defineComponent(() => {
        api = useDragHandle({enabled: () => enabled, rect: () => rect ?? undefined, to})
        return () => h('header', {onPointerdown: api.down, onClickCapture: api.click}, [h('span', {class: 'grip'}, 'Chat'), h('button', 'Close'), h('a', {href: '#x', class: 'link'}, 'Link')])
    })
    const wrapper = await mountSuspended(Host, {attachTo: document.body})
    mounted.push(wrapper)
    return {wrapper, api, to}
}
const pointer = (type: string, more: Record<string, unknown> = {}) => {
    const event = new Event(type, {bubbles: true, cancelable: true})
    Object.assign(event, {button: 0, buttons: 1, pointerId: 1, clientX: 0, clientY: 0}, more)
    return event as PointerEvent
}
const press = (element: Element, more: Record<string, unknown> = {}) => {
    const event = pointer('pointerdown', more)
    element.dispatchEvent(event)
    return event
}
const go = (x: number, y: number, more: Record<string, unknown> = {}) => window.dispatchEvent(pointer('pointermove', {clientX: x, clientY: y, ...more}))
const lift = (more: Record<string, unknown> = {}) => window.dispatchEvent(pointer('pointerup', more))

describe('useDragHandle', () => {
    it('tells a control from the grip', () => {
        document.body.innerHTML = '<div role="menu"><span id="in">x</span></div><a id="a">y</a>'
        expect(isControl(document.getElementById('in'))).toBe(true)
        expect(isControl(document.getElementById('a'))).toBe(false)
        expect(isControl(null)).toBe(false)
    })

    it('moves the window once the pointer has gone a few pixels, from where it was pressed', async () => {
        const {wrapper, api, to} = await mount()
        press(wrapper.get('.grip').element)
        go(2, 2)
        expect(api.moving.value).toBe(false)
        expect(to).not.toHaveBeenCalled()
        go(30, 40)
        expect(api.moving.value).toBe(true)
        expect(to).toHaveBeenLastCalledWith(box, 30, 40)
        await wrapper.vm.$nextTick()
        expect(document.documentElement.classList.contains('cursor-grabbing')).toBe(true)
        // Another pointer is not this drag.
        go(99, 99, {pointerId: 2})
        expect(to).toHaveBeenCalledTimes(1)
        lift()
        expect(api.moving.value).toBe(false)
        await wrapper.vm.$nextTick()
        expect(document.documentElement.classList.contains('cursor-grabbing')).toBe(false)
        go(50, 50)
        expect(to).toHaveBeenCalledTimes(1)
    })

    it('leaves a press on a control, a right button, a window not movable now, or one with no box', async () => {
        for (const [enabled, rect, on, button] of [[true, box, 'button', 0], [true, box, '.grip', 2], [false, box, '.grip', 0], [true, null, '.grip', 0]] as const) {
            const {wrapper, to} = await mount(enabled, rect)
            press(wrapper.get(on).element, {button})
            go(30, 40)
            lift()
            expect(to, `${enabled} ${!!rect} ${on} ${button}`).not.toHaveBeenCalled()
        }
    })

    it('ends the drag when the button was let go outside the page', async () => {
        const {wrapper, api, to} = await mount()
        press(wrapper.get('.grip').element)
        go(30, 40)
        go(60, 60, {buttons: 0})
        expect(api.moving.value).toBe(false)
        expect(to).toHaveBeenCalledTimes(1)
    })

    it("keeps a link from opening once it was dragged from, and lets it open on a plain click", async () => {
        const {wrapper} = await mount()
        const link = wrapper.get('.link').element
        expect(press(link).defaultPrevented).toBe(true)
        go(30, 40)
        lift()
        const dragged = new MouseEvent('click', {bubbles: true, cancelable: true})
        link.dispatchEvent(dragged)
        expect(dragged.defaultPrevented).toBe(true)

        press(link)
        lift()
        const clicked = new MouseEvent('click', {bubbles: true, cancelable: true})
        link.dispatchEvent(clicked)
        expect(clicked.defaultPrevented).toBe(false)
    })

    it('lets a later click through when none came with the drop', async () => {
        const {wrapper} = await mount()
        press(wrapper.get('.grip').element)
        go(30, 40)
        lift()
        await new Promise(resolve => setTimeout(resolve, 5))
        const later = new MouseEvent('click', {bubbles: true, cancelable: true})
        wrapper.get('.grip').element.dispatchEvent(later)
        expect(later.defaultPrevented).toBe(false)
    })
})
