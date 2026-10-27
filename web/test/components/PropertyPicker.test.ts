import {afterEach, describe, expect, it} from 'vitest'
import {nextTick} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import PropertyPicker from '~/components/PropertyPicker.vue'

const mounted: VueWrapper[] = []
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

// Headless UI moves the lit option a frame after a key, as the page would.
const settled = () => new Promise(resolve => requestAnimationFrame(resolve)).then(() => nextTick())

const OPTIONS = [{value: 'todo', label: 'Todo'}, {value: 'in-progress', label: 'In progress'}, {value: 'done', label: 'Done'}]

async function mount(modelValue: string | string[], extra: Record<string, unknown> = {}) {
    const updates: (string | string[])[] = []
    const wrapper = await mountSuspended(PropertyPicker, {
        props: {options: OPTIONS, label: 'Status', modelValue, 'onUpdate:modelValue': (v: string | string[]) => updates.push(v), ...extra},
        attachTo: document.body,
    })
    mounted.push(wrapper)
    await wrapper.find('button').trigger('click')
    await settled()
    const key = (k: string) => wrapper.find('input').trigger('keydown', {key: k}).then(settled)
    const type = (text: string) => wrapper.find('input').setValue(text).then(settled).then(settled)
    const rows = () => wrapper.findAll('li').map(li => li.text())
    return {wrapper, updates, key, type, rows}
}

describe('PropertyPicker', () => {
    it('opens on what is picked, so Enter keeps it and closes', async () => {
        const {wrapper, updates, key} = await mount('in-progress')
        expect(wrapper.find('li.bg-active').text()).toBe('In progress')
        await key('Enter')
        expect(updates).toEqual([])
        expect(wrapper.find('[role=listbox]').exists()).toBe(false)
    })

    it('narrows as you type, those starting with it first, and picks with the arrows', async () => {
        const {updates, key, type, rows} = await mount('todo')
        await type('do')
        expect(rows()).toEqual(['Done', 'Todo'])
        await key('Enter')
        expect(updates).toEqual(['done'])
    })

    it('moves with the arrows, and stops at the ends', async () => {
        const {updates, key} = await mount('todo')
        await key('ArrowUp')
        await key('ArrowDown')
        await key('ArrowDown')
        await key('ArrowDown')
        await key('Enter')
        expect(updates).toEqual(['done'])
    })

    it('says when nothing matches, and Escape closes without a pick', async () => {
        const {wrapper, updates, key, type, rows} = await mount('todo')
        await type('zzz')
        expect(rows()).toEqual(['Nothing matches'])
        await key('Escape')
        expect(wrapper.find('[role=listbox]').exists()).toBe(false)
        expect(updates).toEqual([])
    })

    it('toggles many and stays open, and offers what was typed when it can make one', async () => {
        const {wrapper, updates, key, type, rows} = await mount(['todo'], {multiple: true, creatable: true, createVerb: 'Add'})
        // Headless UI picks on the press, so a drag off the option doesn't pick it.
        await wrapper.findAll('li')[0]!.trigger('mousedown', {button: 0})
        expect(updates.at(-1)).toEqual([])
        expect(wrapper.find('[role=listbox]').exists()).toBe(true)
        await type('Blocked')
        expect(rows()).toEqual(['+ Add “Blocked”'])
        await key('Enter')
        expect(updates.at(-1)).toEqual(['todo', 'Blocked'])
        await type('done')
        expect(rows()).toEqual(['Done'])
    })
})
