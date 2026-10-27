import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import SelectBox from '~/components/SelectBox.vue'

// A row's tick: a click ticks and unticks it, a shift-click ticks the run from the last one, and a press ticks it
// without the click it ends in ticking it twice.
const mounted: VueWrapper[] = []
beforeEach(() => useSelection().clear())
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    document.body.innerHTML = ''
})

async function mount(id: string, project = 'greenhouse') {
    const wrapper = await mountSuspended(SelectBox, {props: {project, id}, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper.find('button')
}

describe('SelectBox', () => {
    it('ticks and unticks its issue on a click, and says so', async () => {
        const tick = await mount('GRE-1')
        expect(tick.attributes('aria-label')).toBe('Select GRE-1')
        expect(tick.attributes('aria-checked')).toBe('false')
        await tick.trigger('click')
        expect(useSelection().selected.value).toEqual(['greenhouse/GRE-1'])
        expect(tick.attributes('aria-checked')).toBe('true')
        await tick.trigger('click')
        expect(useSelection().selected.value).toEqual([])
    })

    it('ticks the run from the last one ticked on a shift-click, in the order of the page', async () => {
        const main = document.createElement('main')
        for (const id of ['GRE-1', 'GRE-2', 'GRE-3', 'GRE-4']) {
            const row = document.createElement('div')
            Object.assign(row.dataset, {project: 'greenhouse', issue: id})
            main.append(row)
        }
        document.body.append(main)
        const first = await mount('GRE-1')
        const third = await mount('GRE-3')
        await first.trigger('click')
        await third.trigger('click', {shiftKey: true})
        expect(useSelection().selected.value).toEqual(['greenhouse/GRE-1', 'greenhouse/GRE-2', 'greenhouse/GRE-3'])
    })

    it('ticks on a press, and eats the click it ends in', async () => {
        const tick = await mount('GRE-1')
        await tick.trigger('pointerdown', {button: 0, pointerType: 'mouse'})
        expect(useSelection().selected.value).toEqual(['greenhouse/GRE-1'])
        window.dispatchEvent(new PointerEvent('pointerup'))
        await tick.trigger('click')
        expect(useSelection().selected.value).toEqual(['greenhouse/GRE-1'])
    })
})
