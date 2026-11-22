import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import DocsNav from '~/components/DocsNav.vue'

// A project's docs down the side (ORR-520): loose ones first, then each section, folding away and kept folded in this
// browser; a doc filed by dragging it onto a section or from its right-click menu; sections made at the foot, renamed
// and deleted from their own menu (ORR-560), and dragged above or below another (ORR-767).
let sent: {method: string, path: string, body?: unknown}[] = []
let down = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/shelves/deleted-docs', () => [])
const record = (method: string, path: string) => registerEndpoint(`/api/projects/shelves/${path}`, {method, handler: async event => {
    sent.push({method, path, ...method === 'DELETE' ? {} : {body: await readBody(event)}})
    if (down) {
        setResponseStatus(event, 500)
        return {}
    }
    return {}
}})
for (const doc of ['plan', 'oak', 'pine']) record('PATCH', `docs/${doc}`)
for (const section of ['Wood', 'Tools', 'Joinery', 'Timber']) {
    record('PATCH', `doc-sections/${section}`)
    record('DELETE', `doc-sections/${section}`)
}
record('POST', 'doc-sections')

const docs = [
    {id: 'plan', title: 'Plan', kind: 'doc'},
    {id: 'oak', title: 'Oak', kind: 'doc', section: 'Wood'},
    {id: 'pine', title: 'Pine', kind: 'artifact', section: 'Wood'},
]
const project = (sections = ['Wood', 'Tools'], list: unknown[] = docs) => ({id: 'shelves', name: 'Shelves', key: 'SHE', docs: list, doc_sections: sections}) as unknown as Project

const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    down = false
    localStorage.clear()
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(route = '/p/shelves/docs', p = project()) {
    const wrapper = await mountSuspended(DocsNav, {props: {project: p}, route, attachTo: document.body})
    mounted.push(wrapper)
    return wrapper
}
const header = (wrapper: VueWrapper, name: string) => wrapper.get(`section[aria-label="${name}"] [role="button"]`)
const link = (wrapper: VueWrapper, title: string) => wrapper.findAll('a').find(a => a.get('span.truncate').text() === title)!
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find(b => b.textContent?.trim() === text)

describe('DocsNav sections', () => {
    it('lists the loose docs first, then each section with its count, and an empty one too', async () => {
        const wrapper = await mount()
        expect(wrapper.findAll('a').map(a => a.get('span.truncate').text())).toEqual(['Plan', 'Oak', 'Pine'])
        expect(header(wrapper, 'Wood').text()).toMatch(/Wood\s*2/)
        expect(header(wrapper, 'Tools').text()).toMatch(/Tools\s*0/)
        expect(link(wrapper, 'Pine').find('svg title').text()).toBe('Artifact')
    })

    it('folds a section by a click or the keys, and keeps it folded for that project', async () => {
        const wrapper = await mount()
        await header(wrapper, 'Wood').trigger('click')
        expect(header(wrapper, 'Wood').attributes('aria-expanded')).toBe('false')
        expect(link(wrapper, 'Oak').classes()).toContain('md:hidden')
        expect(JSON.parse(localStorage.getItem('orrery-docs-folded:shelves')!)).toEqual(['Wood'])
        await header(wrapper, 'Wood').trigger('keydown', {key: 'Enter'})
        expect(header(wrapper, 'Wood').attributes('aria-expanded')).toBe('true')
        await header(wrapper, 'Wood').trigger('keydown', {key: ' '})
        expect(header(wrapper, 'Wood').attributes('aria-expanded')).toBe('false')

        const again = await mount()
        expect(header(again, 'Wood').attributes('aria-expanded')).toBe('false')
    })

    it('reads a broken fold list as nothing folded, and unfolds the section of the doc opened', async () => {
        localStorage.setItem('orrery-docs-folded:shelves', '{not json')
        expect(header(await mount(), 'Wood').attributes('aria-expanded')).toBe('true')
        localStorage.setItem('orrery-docs-folded:shelves', '["Wood","Tools"]')
        const wrapper = await mount('/p/shelves/docs/oak')
        expect(header(wrapper, 'Wood').attributes('aria-expanded')).toBe('true')
        expect(header(wrapper, 'Tools').attributes('aria-expanded')).toBe('false')
        expect(link(wrapper, 'Oak').attributes('aria-current')).toBe('page')
    })

    it('files a doc dragged onto a section, or onto Docs for none, and leaves one dropped where it is', async () => {
        const wrapper = await mount()
        await link(wrapper, 'Plan').trigger('dragstart')
        await header(wrapper, 'Tools').trigger('dragover')
        expect(header(wrapper, 'Tools').classes()).toContain('bg-active')
        await header(wrapper, 'Tools').trigger('dragleave')
        expect(header(wrapper, 'Tools').classes()).not.toContain('bg-active')
        await header(wrapper, 'Tools').trigger('drop')
        await link(wrapper, 'Oak').trigger('dragstart')
        const docsLabel = wrapper.get('p.label')
        await docsLabel.trigger('dragover')
        expect(docsLabel.classes()).toContain('bg-active')
        await docsLabel.trigger('drop')
        await link(wrapper, 'Pine').trigger('dragstart')
        await header(wrapper, 'Wood').trigger('drop')
        await link(wrapper, 'Pine').trigger('dragend')
        await flushPromises()
        expect(sent).toEqual([
            {method: 'PATCH', path: 'docs/plan', body: {section: 'Tools'}},
            {method: 'PATCH', path: 'docs/oak', body: {section: null}},
        ])
    })

    it('moves a doc from its right-click menu, to a section, none or a new one', async () => {
        const wrapper = await mount()
        await link(wrapper, 'Oak').trigger('contextmenu', {clientX: 10, clientY: 10})
        expect(menu()?.textContent).toContain('Move to section')
        menuItem('Tools')!.click()
        await flushPromises()
        expect(menu()).toBeNull()
        await link(wrapper, 'Oak').trigger('contextmenu')
        menuItem('No section')!.click()
        await flushPromises()
        await link(wrapper, 'Plan').trigger('contextmenu')
        menuItem('+ New section…')!.click()
        await flushPromises()
        const input = menu()!.querySelector<HTMLInputElement>('input[aria-label="New section"]')!
        input.value = '  Joinery '
        input.dispatchEvent(new Event('input'))
        input.form!.dispatchEvent(new Event('submit', {cancelable: true}))
        await flushPromises()
        await vi.waitFor(() => expect(sent).toHaveLength(3))
        expect(sent).toEqual([
            {method: 'PATCH', path: 'docs/oak', body: {section: 'Tools'}},
            {method: 'PATCH', path: 'docs/oak', body: {section: null}},
            {method: 'PATCH', path: 'docs/plan', body: {section: 'Joinery'}},
        ])
    })

    it('renames a section from its menu, keeping it folded, and does nothing for the same name', async () => {
        localStorage.setItem('orrery-docs-folded:shelves', '["Wood"]')
        const wrapper = await mount()
        await header(wrapper, 'Wood').trigger('contextmenu')
        menuItem('Rename…')!.click()
        await flushPromises()
        const input = menu()!.querySelector<HTMLInputElement>('input')!
        expect(input.value).toBe('Wood')
        input.form!.dispatchEvent(new Event('submit', {cancelable: true}))
        await flushPromises()
        expect(sent).toEqual([])

        await header(wrapper, 'Wood').trigger('contextmenu')
        menuItem('Rename…')!.click()
        await flushPromises()
        const box = menu()!.querySelector<HTMLInputElement>('input')!
        box.value = 'Timber'
        box.dispatchEvent(new Event('input'))
        box.form!.dispatchEvent(new Event('submit', {cancelable: true}))
        await vi.waitFor(() => expect(sent).toEqual([{method: 'PATCH', path: 'doc-sections/Wood', body: {name: 'Timber'}}]))
        await vi.waitFor(() => expect(JSON.parse(localStorage.getItem('orrery-docs-folded:shelves')!)).toEqual(['Timber']))
    })

    it('deletes a section from its menu', async () => {
        const wrapper = await mount()
        await header(wrapper, 'Tools').trigger('contextmenu')
        menuItem('Delete section')!.click()
        await vi.waitFor(() => expect(sent).toEqual([{method: 'DELETE', path: 'doc-sections/Tools'}]))
    })

    it('makes a section at the foot, and drops the box on Esc or when left empty', async () => {
        const wrapper = await mount()
        const start = () => wrapper.findAll('button').find(b => b.text() === 'New section')!.trigger('click')
        await start()
        await wrapper.get('form input[aria-label="New section"]').trigger('keydown', {key: 'Escape'})
        expect(wrapper.find('form input[aria-label="New section"]').exists()).toBe(false)
        await start()
        await wrapper.get('form input[aria-label="New section"]').trigger('blur')
        expect(wrapper.find('form input[aria-label="New section"]').exists()).toBe(false)
        await start()
        await wrapper.get('form').trigger('submit')
        expect(wrapper.find('form input[aria-label="New section"]').exists()).toBe(false)
        await start()
        await wrapper.get('form input[aria-label="New section"]').setValue('  Tools  ')
        await wrapper.get('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toEqual([{method: 'POST', path: 'doc-sections', body: {name: 'Tools'}}]))
        expect(wrapper.find('form input[aria-label="New section"]').exists()).toBe(false)
    })

    it('keeps the box and says why when making one fails', async () => {
        down = true
        const wrapper = await mount()
        await wrapper.findAll('button').find(b => b.text() === 'New section')!.trigger('click')
        await wrapper.get('form input[aria-label="New section"]').setValue('Tools')
        await wrapper.get('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain("Couldn't save it. Is orrery running?"))
        expect(wrapper.find('form input[aria-label="New section"]').exists()).toBe(true)
    })

    it('drags a section by its header above or below another, putting it back if the save fails', async () => {
        const wrapper = await mount('/p/shelves/docs', project(['Wood', 'Tools', 'Joinery']))
        const shown = () => wrapper.findAll('section').map(s => s.attributes('aria-label'))
        const at = (name: string, clientY: number) => {
            const section = wrapper.get(`section[aria-label="${name}"]`).element as HTMLElement
            section.getBoundingClientRect = () => ({top: 100, height: 40, bottom: 140, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({})})
            const event = new Event('dragover', {bubbles: true, cancelable: true})
            Object.defineProperty(event, 'clientY', {value: clientY})
            section.dispatchEvent(event)
            return event
        }
        // Not a section on the move: nothing happens.
        expect(at('Tools', 130).defaultPrevented).toBe(false)
        await header(wrapper, 'Wood').trigger('dragstart')
        expect(wrapper.get('section[aria-label="Wood"]').classes()).toContain('opacity-40')
        expect(at('Joinery', 130).defaultPrevented).toBe(true)
        await flushPromises()
        expect(wrapper.find('section[aria-label="Joinery"] span.bg-accent-500').exists()).toBe(true)
        await wrapper.get('section[aria-label="Joinery"]').trigger('drop')
        await flushPromises()
        expect(shown()).toEqual(['Tools', 'Joinery', 'Wood'])
        expect(sent).toEqual([{method: 'PATCH', path: 'doc-sections/Wood', body: {position: 2}}])

        down = true
        await header(wrapper, 'Joinery').trigger('dragstart')
        at('Tools', 110)
        await wrapper.get('section[aria-label="Tools"]').trigger('drop')
        await vi.waitFor(() => expect(shown()).toEqual(['Wood', 'Tools', 'Joinery']))
        expect(wrapper.text()).toContain("Couldn't save it. Is orrery running?")

        // Dropped where it already is: no save.
        sent = []
        await header(wrapper, 'Tools').trigger('dragstart')
        at('Tools', 110)
        await wrapper.get('section[aria-label="Tools"]').trigger('drop')
        await header(wrapper, 'Tools').trigger('dragend')
        await flushPromises()
        expect(sent).toEqual([])
        expect(wrapper.find('.opacity-40').exists()).toBe(false)
    })

    it('opens a new doc or artifact for the project', async () => {
        const wrapper = await mount()
        await wrapper.findAll('button').find(b => b.text() === 'New doc')!.trigger('click')
        expect([useNewDoc().target.value, useNewDoc().kind.value]).toEqual(['shelves', 'markdown'])
        await wrapper.findAll('button').find(b => b.text() === 'New artifact')!.trigger('click')
        expect([useNewDoc().target.value, useNewDoc().kind.value]).toEqual(['shelves', 'artifact'])
    })
})
