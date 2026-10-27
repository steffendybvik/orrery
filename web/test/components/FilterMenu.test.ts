import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import FilterMenu from '~/components/FilterMenu.vue'

// A filter's button and menu: what the button says for none, one or several ticked, ticking and unticking, Clear, and
// Esc or a click outside closing it.
const OPTIONS = [{value: 'P1', label: 'High'}, {value: 'P2', label: 'Medium'}, {value: 'P3', label: 'Low'}]

const mounted: VueWrapper[] = []
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(modelValue: string[]) {
    const wrapper = await mountSuspended(FilterMenu, {
        props: {label: 'Priority', options: OPTIONS, modelValue, 'onUpdate:modelValue': (v: string[]) => wrapper.setProps({modelValue: v})},
        attachTo: document.body,
    })
    mounted.push(wrapper)
    const toggle = () => wrapper.find('button[aria-expanded]')
    // Headless UI's Listbox ticks an option on its click, and Clear is a button under them.
    const option = (text: string) => wrapper.findAll('[role=option], button').find(b => b.text() === text)!
    const model = () => wrapper.props('modelValue') as string[]
    return {wrapper, toggle, option, model}
}

describe('FilterMenu', () => {
    it('says its label with nothing ticked, the option with one, and a count with more', async () => {
        const {wrapper, toggle, option} = await mount([])
        expect(toggle().text()).toBe('Priority')
        await toggle().trigger('click')
        await option('Medium').trigger('click')
        expect(toggle().text()).toBe('Medium')
        await option('Low').trigger('click')
        expect(toggle().text()).toBe('Priority · 2')
        expect(wrapper.props('modelValue')).toEqual(['P2', 'P3'])
    })

    it('unticks a ticked option, and Clear unticks them all', async () => {
        const {toggle, option, model} = await mount(['P1', 'P3'])
        await toggle().trigger('click')
        await option('High').trigger('click')
        expect(model()).toEqual(['P3'])
        await option('Clear').trigger('click')
        expect(model()).toEqual([])
        expect(toggle().text()).toBe('Priority')
    })

    it('closes on Esc and on a click outside', async () => {
        const {wrapper, toggle} = await mount([])
        await toggle().trigger('click')
        expect(toggle().attributes('aria-expanded')).toBe('true')
        await wrapper.find('[role=listbox]').trigger('keydown', {key: 'Escape'})
        expect(toggle().attributes('aria-expanded')).toBe('false')
        await toggle().trigger('click')
        expect(toggle().attributes('aria-expanded')).toBe('true')
        for (const type of ['pointerdown', 'mousedown', 'click']) document.body.dispatchEvent(new MouseEvent(type, {bubbles: true}))
        await nextTick()
        expect(toggle().attributes('aria-expanded')).toBe('false')
    })
})
