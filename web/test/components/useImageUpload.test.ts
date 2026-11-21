import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {defineComponent, h, ref, toHandlers} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import {readAsDataUrl, useImageUpload} from '~/composables/useImageUpload'

// Images in a Markdown field: pasted, dropped or picked, each kept by orrery and put in as Markdown on a line of its
// own where the cursor is; why one didn't make it; and one from a field opened afresh dropped (`reset`).
let sent: {data: string, name: string | null}[] = []
let failing = false
let hold: Promise<void> | null = null
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/uploads', {method: 'POST', handler: async event => {
    const body = await readBody<{data: string, name: string | null}>(event)
    sent.push(body)
    if (hold) await hold
    if (failing) {
        setResponseStatus(event, 413)
        return {statusCode: 413, message: 'The image is too big'}
    }
    return {markdown: `![${body.name ?? 'image'}](/api/uploads/${sent.length})`}
}})

const png = (name = 'shot.png') => new File([new Uint8Array([137, 80, 78, 71])], name, {type: 'image/png'})
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
    hold = null
})
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function mount(start = '') {
    let api!: ReturnType<typeof useImageUpload>
    const text = ref(start)
    const field = ref<HTMLTextAreaElement | null>(null)
    const Host = defineComponent(() => {
        api = useImageUpload(text, field)
        return () => h('div', {class: 'area', ...toHandlers(api.on)}, [h('textarea', {ref: field, value: text.value})])
    })
    const wrapper = await mountSuspended(Host, {attachTo: document.body})
    mounted.push(wrapper)
    return {wrapper, text, field, api}
}
const transfer = (files: File[], types = ['Files']) => ({types, files, dropEffect: 'none'})
/** A drag or paste event carrying `data`, as happy-dom won't set dataTransfer or clipboardData itself. */
function fire(element: Element, type: string, data: unknown, key = type === 'paste' ? 'clipboardData' : 'dataTransfer') {
    const event = new Event(type, {bubbles: true, cancelable: true})
    Object.defineProperty(event, key, {value: data})
    element.dispatchEvent(event)
    return event
}

describe('useImageUpload', () => {
    it('reads a file as a data: URL', async () => {
        await expect(readAsDataUrl(png())).resolves.toMatch(/^data:image\/png;base64,/)
    })

    it('puts each picked image in on a line of its own at the end, and focuses the field', async () => {
        const {api, text, field} = await mount('Before')
        await api.upload([png('a.png'), new File(['x'], 'notes.txt', {type: 'text/plain'}), png('b.png')])
        await vi.waitFor(() => expect(api.uploading.value).toBe(0))
        expect(text.value).toBe('Before\n![a.png](/api/uploads/1)\n![b.png](/api/uploads/2)\n')
        expect(sent.map(s => s.name)).toEqual(['a.png', 'b.png'])
        expect(sent[0]!.data).toMatch(/^data:image\/png;base64,/)
        await vi.waitFor(() => expect(document.activeElement).toBe(field.value))
    })

    it('puts it in where the cursor is, when the field has the focus', async () => {
        const {api, text, field} = await mount('one\ntwo')
        field.value!.focus()
        field.value!.setSelectionRange(3, 3)
        await api.upload([png()])
        await vi.waitFor(() => expect(text.value).toBe('one\n![shot.png](/api/uploads/1)\ntwo'))
        // After the image's line, not where it was.
        expect(field.value!.selectionStart).toBeGreaterThan('one\n![shot.png](/api/uploads/1)'.length - 1)
    })

    it('does nothing for no images, and sends no name for a file without one', async () => {
        const {api} = await mount()
        await api.upload([new File(['x'], 'a.txt', {type: 'text/plain'})])
        expect(sent).toEqual([])
        await api.upload([new File([new Uint8Array([1])], '', {type: 'image/gif'})])
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(sent[0]!.name).toBeNull()
    })

    it('says why one did not make it, and clears that on the next', async () => {
        const {api, text} = await mount()
        failing = true
        await api.upload([png()])
        expect(api.failed.value).toBe('The image is too big')
        expect(text.value).toBe('')
        failing = false
        const next = api.upload([png()])
        expect(api.failed.value).toBe('')
        await next
        expect(text.value).toContain('![shot.png]')
    })

    it('drops one still on its way once the field is opened afresh', async () => {
        const {api, text} = await mount()
        let release!: () => void
        hold = new Promise(resolve => release = resolve)
        const going = api.upload([png(), png('second.png')])
        await vi.waitFor(() => expect(sent).toHaveLength(1))
        expect(api.uploading.value).toBe(2)
        api.reset()
        expect(api.uploading.value).toBe(0)
        release()
        await going
        expect(text.value).toBe('')
        expect(sent).toHaveLength(1)
        expect(api.uploading.value).toBe(0)
    })

    it('shows the drop overlay while files are dragged over, counting the elements inside, and takes a drop', async () => {
        const {wrapper, api, text} = await mount()
        const area = wrapper.get('.area').element
        const inner = wrapper.get('textarea').element
        expect(fire(area, 'dragenter', transfer([])).defaultPrevented).toBe(true)
        fire(inner, 'dragenter', transfer([]))
        expect(api.over.value).toBe(true)
        fire(inner, 'dragleave', transfer([]))
        expect(api.over.value).toBe(true)
        fire(area, 'dragleave', transfer([]))
        expect(api.over.value).toBe(false)
        const over = transfer([])
        expect(fire(area, 'dragover', over).defaultPrevented).toBe(true)
        expect(over.dropEffect).toBe('copy')
        fire(area, 'dragenter', transfer([]))
        expect(fire(area, 'drop', transfer([png('dropped.png'), new File(['x'], 'a.txt', {type: 'text/plain'})])).defaultPrevented).toBe(true)
        expect(api.over.value).toBe(false)
        await vi.waitFor(() => expect(text.value).toContain('![dropped.png]'))
        expect(sent).toHaveLength(1)
    })

    it('leaves dragged text or a link alone, and a drop of no images', async () => {
        const {wrapper, api} = await mount()
        const area = wrapper.get('.area').element
        expect(fire(area, 'dragenter', transfer([], ['text/plain'])).defaultPrevented).toBe(false)
        expect(api.over.value).toBe(false)
        expect(fire(area, 'dragover', transfer([], ['text/uri-list'])).defaultPrevented).toBe(false)
        fire(area, 'dragleave', transfer([], ['text/plain']))
        expect(fire(area, 'drop', transfer([], ['text/plain'])).defaultPrevented).toBe(false)
        fire(area, 'drop', transfer([new File(['x'], 'a.txt', {type: 'text/plain'})]))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(sent).toEqual([])
    })

    it('takes a pasted image, and lets a paste of text through', async () => {
        const {wrapper, text} = await mount()
        const area = wrapper.get('.area').element
        expect(fire(area, 'paste', {files: []}).defaultPrevented).toBe(false)
        expect(fire(area, 'paste', {files: [png('pasted.png')]}).defaultPrevented).toBe(true)
        await vi.waitFor(() => expect(text.value).toContain('![pasted.png]'))
    })
})
