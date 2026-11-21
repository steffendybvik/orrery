import {afterEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import {defineComponent, h} from 'vue'

// The keys on a page of rows (useHotkeys): j/k move between the rows shown, Enter opens the one focused, x ticks it
// (shift-x the run up to it), ⌘A ticks every one, / goes to the search box; a key held with ⌥ or one of a dialog's
// is left alone.
const opened: string[] = []
const Rows = defineComponent({
    setup() {
        useHotkeys()
        const row = (id: string, shown = true) => h('div', {
            'data-nav': '', 'data-issue': id, 'data-project': 'shelves', 'tabindex': 0, 'id': id, 'class': shown ? 'shown' : 'hidden', 'onClick': () => opened.push(id),
        })
        return () => h('main', [h('input', {id: 'search'}), row('SHE-1'), row('SHE-2', false), row('SHE-3'), row('SHE-4')])
    },
})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useSelection().clear()
    useNewIssue().target.value = null
    useState('palette-open').value = false
    opened.length = 0
})

async function mount() {
    const wrapper = await mountSuspended(Rows, {attachTo: document.body})
    mounted.push(wrapper)
    // happy-dom lays nothing out: a row shown has a parent to be offset from, one hidden has none.
    for (const el of document.querySelectorAll<HTMLElement>('main [data-nav]')) {
        Object.defineProperty(el, 'offsetParent', {configurable: true, get: () => el.classList.contains('shown') ? document.body : null})
        el.scrollIntoView = () => {}
    }
    return wrapper
}
const press = (key: string, more: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...more})
    window.dispatchEvent(event)
    return event
}
const focused = () => (document.activeElement as HTMLElement).id

describe('useHotkeys on rows', () => {
    it('moves down and up the rows shown with j and k, from the first or the last, stopping at the ends', async () => {
        await mount()
        expect(press('j').defaultPrevented).toBe(true)
        expect(focused()).toBe('SHE-1')
        press('j')
        expect(focused()).toBe('SHE-3')
        press('j')
        press('j')
        expect(focused()).toBe('SHE-4')
        press('k')
        expect(focused()).toBe('SHE-3')
        ;(document.activeElement as HTMLElement).blur()
        press('k')
        expect(focused()).toBe('SHE-4')
    })

    it('opens the focused row on Enter, and nothing when no row has focus', async () => {
        await mount()
        expect(press('Enter').defaultPrevented).toBe(false)
        press('j')
        press('Enter')
        expect(opened).toEqual(['SHE-1'])
    })

    it('ticks the focused issue on x, the run up to it on shift-x, and every one on ⌘A', async () => {
        await mount()
        press('x')
        expect(useSelection().selected.value).toEqual([])
        press('j')
        press('x')
        expect(useSelection().selected.value).toEqual(['shelves/SHE-1'])
        press('j')
        press('j')
        press('X', {shiftKey: true})
        expect(useSelection().selected.value).toEqual(['shelves/SHE-1', 'shelves/SHE-3', 'shelves/SHE-4'])
        useSelection().clear()
        expect(press('a', {metaKey: true}).defaultPrevented).toBe(true)
        expect(useSelection().selected.value).toEqual(['shelves/SHE-1', 'shelves/SHE-3', 'shelves/SHE-4'])
    })

    it('leaves ⌘A to the box being typed in, and to the palette', async () => {
        await mount()
        const search = document.getElementById('search')!
        search.focus()
        const typing = new KeyboardEvent('keydown', {key: 'a', metaKey: true, bubbles: true, cancelable: true})
        search.dispatchEvent(typing)
        expect(typing.defaultPrevented).toBe(false)
        search.blur()
        useState('palette-open').value = true
        expect(press('a', {ctrlKey: true}).defaultPrevented).toBe(false)
        expect(useSelection().selected.value).toEqual([])
    })

    it('goes to the search box on /', async () => {
        await mount()
        press('/')
        expect(focused()).toBe('search')
    })

    it('leaves a key held with ⌥, one while New issue is open, and one it has no use for', async () => {
        await mount()
        expect(press('j', {altKey: true}).defaultPrevented).toBe(false)
        useNewIssue().target.value = 'shelves'
        expect(press('j').defaultPrevented).toBe(false)
        useNewIssue().target.value = null
        expect(press('q').defaultPrevented).toBe(false)
        // c needs a project in the address, and 1 and 2 a project's page.
        expect(press('c').defaultPrevented).toBe(false)
        expect(useNewIssue().target.value).toBeNull()
        press('1')
        expect(useRoute().query.view).toBeUndefined()
        expect(focused()).not.toBe('SHE-1')
    })
})
