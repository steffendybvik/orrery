import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, ref} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended} from '@nuxt/test-utils/runtime'
import MarkdownField from '~/components/MarkdownField.vue'
import {renderMarkdown} from '~/utils/markdown'

// MarkdownField (ORR-932): a textarea that keeps plain Markdown, with keys and a toolbar that write it.
// happy-dom's execCommand says it inserted text without doing so: refused, the edit takes the fallback a browser
// without it would.
const execCommand = document.execCommand
const mounted: VueWrapper[] = []
beforeEach(() => {
    document.execCommand = () => false
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    document.execCommand = execCommand
})

async function mount(start: string, props: Record<string, unknown> = {}, onKeydown = vi.fn()) {
    const text = ref(start)
    const Host = defineComponent(() => () => h(MarkdownField, {
        'modelValue': text.value, 'onUpdate:modelValue': (v: string) => (text.value = v), 'aria-label': 'Body', onKeydown, ...props,
    }))
    const wrapper = await mountSuspended(Host, {attachTo: document.body})
    mounted.push(wrapper)
    const box = wrapper.find('textarea')
    return {wrapper, box, el: box.element as HTMLTextAreaElement, text, onKeydown}
}

describe('MarkdownField', () => {
    it('passes what it is given to the textarea', async () => {
        const {box, wrapper} = await mount('x')
        expect(box.attributes('aria-label')).toBe('Body')
        expect(wrapper.find('[role="toolbar"]').exists()).toBe(false)
    })

    it('makes the selection bold on ⌘B, without the box seeing the key', async () => {
        const {box, el, text, onKeydown} = await mount('make this bold')
        el.focus()
        el.setSelectionRange(5, 9)
        await box.trigger('keydown', {key: 'b', metaKey: true})
        expect(text.value).toBe('make **this** bold')
        expect(onKeydown).not.toHaveBeenCalled()
    })

    it('continues a list on Enter, or on Shift-Enter where Enter sends', async () => {
        const plain = await mount('- a')
        plain.el.setSelectionRange(3, 3)
        await plain.box.trigger('keydown', {key: 'Enter'})
        expect(plain.text.value).toBe('- a\n- ')

        const chat = await mount('- a', {enterSends: true})
        chat.el.setSelectionRange(3, 3)
        await chat.box.trigger('keydown', {key: 'Enter'})
        expect(chat.text.value).toBe('- a')
        expect(chat.onKeydown).toHaveBeenCalledTimes(1)
        await chat.box.trigger('keydown', {key: 'Enter', shiftKey: true})
        expect(chat.text.value).toBe('- a\n- ')
        expect(chat.onKeydown).toHaveBeenCalledTimes(1)
    })

    it('formats from its toolbar', async () => {
        const {wrapper, el, text} = await mount('a\nb', {toolbar: true})
        el.setSelectionRange(0, 3)
        await wrapper.find('[aria-label^="Numbered list"]').trigger('click')
        expect(text.value).toBe('1. a\n2. b')
    })

    it('draws the source with its formatting', async () => {
        const {wrapper} = await mount('**b** ==h==')
        const draw = wrapper.find('.md-draw')
        expect(draw.attributes('aria-hidden')).toBe('true')
        expect(draw.find('.md-bold').text()).toBe('**b**')
        expect(draw.find('.md-highlight').text()).toBe('==h==')
    })

    it('writes a highlight that the page shows as one', () => {
        expect(renderMarkdown('a ==**big** deal== b').html).toContain('<mark><strong>big</strong> deal</mark>')
        expect(renderMarkdown('x == y').html).not.toContain('<mark>')
    })

    it("opens orrery's own pages in a new tab only when asked, as the chat does (ORR-944)", () => {
        const link = (html: string) => new DOMParser().parseFromString(html, 'text/html').querySelector('a')!
        const own = '[ORR-943](/p/orrery/issues/ORR-943)'
        expect(link(renderMarkdown(own).html).target).toBe('')
        const opened = link(renderMarkdown(own, undefined, undefined, {newTab: true}).html)
        expect([opened.getAttribute('href'), opened.target, opened.rel]).toEqual(['/p/orrery/issues/ORR-943', '_blank', 'noopener'])
        expect(link(renderMarkdown('[x](//elsewhere.example/a)', undefined, undefined, {newTab: true}).html).rel).toBe('')
        expect(link(renderMarkdown('[x](https://example.com)', undefined, undefined, {newTab: true}).html).rel).toBe('noopener noreferrer')
    })
})
