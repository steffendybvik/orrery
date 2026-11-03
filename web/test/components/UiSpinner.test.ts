import {describe, expect, it} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import UiSpinner from '../../app/components/ui/Spinner.vue'
import UiBusy from '../../app/components/ui/Busy.vue'

// What each frame draws, as braille dot numbers, against the glyph it stands for.
const DRAWN = {'⠋': [1, 2, 4], '⠙': [1, 4, 5], '⠹': [1, 4, 5, 6], '⠸': [4, 5, 6], '⠼': [3, 4, 5, 6], '⠴': [3, 5, 6], '⠦': [2, 3, 6], '⠧': [1, 2, 3, 6], '⠇': [1, 2, 3], '⠏': [1, 2, 3, 4]}

describe('UiSpinner', () => {
    it('draws the braille cycle, a frame to each 14 units of its height', async () => {
        const spinner = await mountSuspended(UiSpinner)
        const frames = Object.values(DRAWN).map(() => [] as number[])
        for (const circle of spinner.findAll('circle')) {
            const x = Number(circle.attributes('cx'))
            const y = Number(circle.attributes('cy'))
            const row = (y % 14 - 3) / 4
            frames[Math.floor(y / 14)]!.push((x === 3 ? 1 : 4) + row)
        }
        expect(frames.map(dots => dots.sort())).toEqual(Object.values(DRAWN))
    })

    it('is hidden from a screen reader unless it has a label of its own', async () => {
        const quiet = await mountSuspended(UiSpinner)
        expect(quiet.attributes('aria-hidden')).toBe('true')
        const labelled = await mountSuspended(UiSpinner, {props: {label: 'Loading'}})
        expect(labelled.attributes('aria-hidden')).toBeUndefined()
        expect(labelled.attributes('role')).toBe('img')
        expect(labelled.attributes('aria-label')).toBe('Loading')
    })
})

describe('UiBusy', () => {
    const mount = (busy: boolean) => mountSuspended(UiBusy, {props: {busy, label: 'Saving…'}, slots: {default: () => 'Save'}})

    it('at rest has only its own words as text, with the label taking up room in the same cell', async () => {
        const wrapper = await mount(false)
        expect(wrapper.text()).toBe('Save')
        expect(wrapper.find('[data-testid="spinner"]').exists()).toBe(false)
        const [words, room] = wrapper.findAll(':scope > span')
        expect(words!.classes()).not.toContain('invisible')
        expect(room!.classes()).toContain('invisible')
        expect(room!.attributes('data-label')).toBe('Saving…')
        for (const cell of [words!, room!]) expect(cell.classes()).toEqual(expect.arrayContaining(['col-start-1', 'row-start-1']))
    })

    it('at work shows the spinner and the label, with its words hidden in the same cell', async () => {
        const wrapper = await mount(true)
        const [words, working] = wrapper.findAll(':scope > span')
        expect(words!.classes()).toContain('invisible')
        expect(working!.classes()).not.toContain('invisible')
        expect(working!.text()).toBe('Saving…')
        expect(working!.find('[data-testid="spinner"]').exists()).toBe(true)
        for (const cell of [words!, working!]) expect(cell.classes()).toEqual(expect.arrayContaining(['col-start-1', 'row-start-1']))
    })
})
