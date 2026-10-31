import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import DocContents from '~/components/DocContents.vue'

// A doc's table of contents: the heading being read is marked as the page scrolls, and the last one once at the bottom,
// which might never reach the top. A browser lays the page out; here each heading says where it is.
const HEADINGS = [{id: 'one', text: 'One', level: 2}, {id: 'two', text: 'Two', level: 3}, {id: 'three', text: 'Three', level: 2}]
const added: HTMLElement[] = []

/** The headings at these distances from the top of the page, in a scrolling element at the top of the window. */
function place(tops: number[]) {
    HEADINGS.forEach((heading, at) => {
        const element = document.getElementById(heading.id) ?? document.body.appendChild(Object.assign(document.createElement('h2'), {id: heading.id}))
        added.push(element)
        element.getBoundingClientRect = () => ({top: tops[at]}) as DOMRect
    })
}
function scroller(scrollTop = 0, clientHeight = 500, scrollHeight = 2000) {
    const root = document.createElement('div')
    root.getBoundingClientRect = () => ({top: 0}) as DOMRect
    Object.defineProperties(root, {scrollTop: {value: scrollTop, writable: true}, clientHeight: {value: clientHeight}, scrollHeight: {value: scrollHeight}})
    return root
}
const reading = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) => wrapper.findAll('a').filter(a => a.classes().includes('border-accent-500')).map(a => a.text())

beforeEach(() => place([0, 800, 1600]))
afterEach(() => added.splice(0).forEach(e => e.remove()))

describe('DocContents', () => {
    it('shows nothing for a doc with no headings', async () => {
        const wrapper = await mountSuspended(DocContents, {props: {headings: [], root: scroller()}})
        expect(wrapper.find('nav').exists()).toBe(false)
    })

    it('lists the headings, an h3 set in, the first marked before any scrolling', async () => {
        const wrapper = await mountSuspended(DocContents, {props: {headings: HEADINGS, root: scroller()}})
        await expect.poll(() => reading(wrapper)).toEqual(['One'])
        const links = wrapper.findAll('a')
        expect(links.map(a => a.attributes('href'))).toEqual(['#one', '#two', '#three'])
        expect(links[1]!.classes()).toContain('pl-6')
        expect(links[0]!.classes()).toContain('pl-3')
    })

    it('follows the page as it scrolls', async () => {
        const root = scroller(10)
        const wrapper = await mountSuspended(DocContents, {props: {headings: HEADINGS, root}})
        place([-800, 40, 900])
        root.dispatchEvent(new Event('scroll'))
        await expect.poll(() => reading(wrapper)).toEqual(['Two'])
    })

    it('marks the last at the bottom, though it never reached the top', async () => {
        const root = scroller(1500, 500, 2000)
        const wrapper = await mountSuspended(DocContents, {props: {headings: HEADINGS, root}})
        place([-1500, -700, 300])
        root.dispatchEvent(new Event('scroll'))
        await expect.poll(() => reading(wrapper)).toEqual(['Three'])
    })

    it('scrolls to the heading clicked, and marks it at once', async () => {
        const wrapper = await mountSuspended(DocContents, {props: {headings: HEADINGS, root: scroller()}})
        const scrolled = vi.fn()
        document.getElementById('three')!.scrollIntoView = scrolled
        await wrapper.findAll('a')[2]!.trigger('click')
        expect(scrolled).toHaveBeenCalledWith({behavior: 'smooth', block: 'start'})
        expect(reading(wrapper)).toEqual(['Three'])
    })

    it('stops listening once it is gone', async () => {
        const root = scroller()
        const removed = vi.spyOn(root, 'removeEventListener')
        const wrapper = await mountSuspended(DocContents, {props: {headings: HEADINGS, root}})
        wrapper.unmount()
        expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function))
    })
})
