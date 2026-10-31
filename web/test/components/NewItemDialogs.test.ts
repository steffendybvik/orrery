import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import NewChunkDialog from '~/components/NewChunkDialog.vue'
import NewDocDialog from '~/components/NewDocDialog.vue'
import NewProjectDialog from '~/components/NewProjectDialog.vue'

// New chunk, New doc and New project: what each sends, where it goes after, what it won't send, and that a refusal leaves
// the words in it. The browser specs walk a good create; these hold the rest.
let sent: {path: string, body: Record<string, unknown>}[] = []
let refusal = ''
function endpoint(path: string, answer: Record<string, unknown>) {
    registerEndpoint(`/api${path}`, {method: 'POST', handler: async event => {
        if (refusal) {
            setResponseStatus(event, 400)
            return {message: refusal}
        }
        sent.push({path, body: await readBody(event)})
        return answer
    }})
}
endpoint('/projects/greenhouse/chunks', {id: '3'})
endpoint('/projects/greenhouse/docs', {id: 'how-it-grows'})
endpoint('/projects', {id: 'my-app'})
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))

const mounted: VueWrapper[] = []
let push: ReturnType<typeof vi.spyOn>
beforeEach(() => {
    sent = []
    refusal = ''
    useRoadmaps().projects.value = [{id: 'greenhouse', name: 'Greenhouse', key: 'GRE', board: {chunks: []}}] as unknown as Project[]
    push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useNewChunk().close()
    useNewDoc().close()
    useState('new-project').value = false
    push.mockRestore()
})

async function mount(component: Parameters<typeof mountSuspended>[0]) {
    mounted.push(await mountSuspended(component, {attachTo: document.body}) as VueWrapper)
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    return new DOMWrapper(document.body)
}
const value = (wrapper: DOMWrapper<Element>, label: string) => (wrapper.find(`[aria-label="${label}"]`).element as HTMLInputElement).value
const submitDisabled = (wrapper: DOMWrapper<Element>) => (wrapper.find('button[type="submit"]').element as HTMLButtonElement).disabled

describe('NewChunkDialog', () => {
    it('sends the trimmed title, a summary only when there is one, and opens the chunk', async () => {
        useNewChunk().open('greenhouse')
        const wrapper = await mount(NewChunkDialog)
        expect(wrapper.text()).toContain('New chunk in Greenhouse')
        expect(submitDisabled(wrapper)).toBe(true)
        await wrapper.find('[aria-label="Title"]').setValue('  Moving parts ')
        expect(submitDisabled(wrapper)).toBe(false)
        await wrapper.find('[aria-label="Summary"]').setValue('   ')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{path: '/projects/greenhouse/chunks', body: {title: 'Moving parts'}}])
        await expect.poll(() => push.mock.calls[0]?.[0]).toContain('/p/greenhouse/roadmap/3')
        expect(useNewChunk().target.value).toBeNull()
    })

    it("won't send without a title, says why it was refused, and starts empty next time", async () => {
        useNewChunk().open('greenhouse')
        const wrapper = await mount(NewChunkDialog)
        await wrapper.find('form').trigger('submit')
        await wrapper.find('[aria-label="Title"]').setValue('   ')
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])

        refusal = 'Greenhouse is archived'
        await wrapper.find('[aria-label="Title"]').setValue('Moving parts')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('Greenhouse is archived')
        expect(useNewChunk().target.value).toBe('greenhouse')
        expect(value(wrapper, 'Title')).toBe('Moving parts')
        expect(push).not.toHaveBeenCalled()

        useNewChunk().close()
        await nextTick()
        useNewChunk().open('greenhouse')
        await expect.poll(() => value(new DOMWrapper(document.body), 'Title')).toBe('')
    })
})

describe('NewDocDialog', () => {
    it('sends a Markdown doc and opens it by the id orrery made', async () => {
        useNewDoc().open('greenhouse')
        const wrapper = await mount(NewDocDialog)
        expect(wrapper.text()).toContain('New doc in Greenhouse')
        await wrapper.find('[aria-label="Title"]').setValue(' How it grows ')
        await wrapper.find('[aria-label="Text"]').setValue('# Slowly\n')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{path: '/projects/greenhouse/docs', body: {title: 'How it grows', body: '# Slowly'}}])
        await expect.poll(() => push.mock.calls[0]?.[0]).toBe('/p/greenhouse/docs/how-it-grows')
    })

    it('marks an artifact as one, with no way to add an image', async () => {
        useNewDoc().open('greenhouse', 'artifact')
        const wrapper = await mount(NewDocDialog)
        expect(wrapper.text()).toContain('New artifact in Greenhouse')
        expect(wrapper.text()).toContain('Create artifact')
        expect((wrapper.find('[aria-label="Text"]').element as HTMLTextAreaElement).placeholder).toContain('locked-down frame')
        expect(wrapper.find('input[type="file"]').exists()).toBe(false)
        await wrapper.find('[aria-label="Title"]').setValue('Test speed')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent[0]?.body).toEqual({title: 'Test speed', body: '', kind: 'artifact'})
    })

    it('stays open with what was refused, and sends nothing without a title', async () => {
        useNewDoc().open('greenhouse')
        const wrapper = await mount(NewDocDialog)
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])
        refusal = 'Too long'
        await wrapper.find('[aria-label="Title"]').setValue('How it grows')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('Too long')
        expect(useNewDoc().target.value).toBe('greenhouse')
    })
})

describe('NewProjectDialog', () => {
    const open = async () => {
        useState('new-project').value = true
        return await mount(NewProjectDialog)
    }

    it('suggests the key and id from the name, and sends them', async () => {
        const wrapper = await open()
        await wrapper.find('[aria-label="Name"]').setValue('  My App! ')
        expect(value(wrapper, 'Key')).toBe('MYA')
        expect(value(wrapper, 'Id')).toBe('my-app')
        expect(wrapper.text()).toContain('MYA-1')
        expect(wrapper.text()).toContain('/p/my-app')
        await wrapper.find('[aria-label="Description"]').setValue('An app')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => sent).toEqual([{path: '/projects', body: {name: 'My App!', key: 'MYA', id: 'my-app', description: 'An app'}}])
        await expect.poll(() => push.mock.calls[0]?.[0]).toBe('/p/my-app')
        expect(useState('new-project').value).toBe(false)
    })

    it('stops suggesting a key or id once it has been changed by hand, and capitalises a typed key', async () => {
        const wrapper = await open()
        await wrapper.find('[aria-label="Key"]').setValue('gre')
        expect(value(wrapper, 'Key')).toBe('GRE')
        await wrapper.find('[aria-label="Id"]').setValue('plants')
        await wrapper.find('[aria-label="Name"]').setValue('Greenhouse')
        expect(value(wrapper, 'Key')).toBe('GRE')
        expect(value(wrapper, 'Id')).toBe('plants')
    })

    it('says what is wrong with a key or id it would refuse, and sends neither', async () => {
        const wrapper = await open()
        await wrapper.find('[aria-label="Name"]').setValue('Greenhouse')
        await wrapper.find('[aria-label="Key"]').setValue('1AB')
        expect(wrapper.text()).toContain('The key is capitals and digits')
        expect(submitDisabled(wrapper)).toBe(true)
        await wrapper.find('[aria-label="Key"]').setValue('GRE')
        await wrapper.find('[aria-label="Id"]').setValue('Not An Id')
        expect(wrapper.text()).toContain('The id is lowercase letters')
        expect(wrapper.text()).toContain('/p/id')
        expect(submitDisabled(wrapper)).toBe(true)
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])
    })

    it('makes a key that starts with a letter from a name that starts with a digit', async () => {
        const wrapper = await open()
        await wrapper.find('[aria-label="Name"]').setValue('3D Printer')
        expect(value(wrapper, 'Key')).toBe('DPR')
        expect(value(wrapper, 'Id')).toBe('3d-printer')
    })

    it('stays open with what was refused', async () => {
        const wrapper = await open()
        refusal = 'There is already a project my-app'
        await wrapper.find('[aria-label="Name"]').setValue('My App')
        await wrapper.find('form').trigger('submit')
        await expect.poll(() => wrapper.text()).toContain('There is already a project my-app')
        expect(useState('new-project').value).toBe(true)
        expect(push).not.toHaveBeenCalled()
    })
})
