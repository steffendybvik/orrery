import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {DOMWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import type {Project} from '#shared/roadmap'
import NewIssueDialog from '~/components/NewIssueDialog.vue'

// Writing a new issue: what it sends, as the owner, and the focus that asks a session to pick it up.
let sent: {path: string, actor?: string, body: unknown}[] = []
let failing = false
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/larder/issues', {method: 'POST', handler: async event => {
    if (failing) {
        setResponseStatus(event, 400)
        return {message: 'Larder is archived'}
    }
    sent.push({path: 'issues', actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {id: 'LAR-7'}
}})
registerEndpoint('/api/projects/larder/issues/LAR-7/focus', {method: 'POST', handler: async event => {
    sent.push({path: 'focus', actor: getHeader(event, 'orrery-actor'), body: await readBody(event)})
    return {}
}})

const LARDER = {id: 'larder', name: 'Larder', key: 'LAR', board: {chunks: [{id: 'pantry', title: 'Pantry', tasks: []}, {id: '', title: 'No chunk', tasks: []}]}} as unknown as Project
const mounted: VueWrapper[] = []
beforeEach(() => {
    sent = []
    failing = false
    useRoadmaps().projects.value = [LARDER]
    useAppSettings().settings.value.statuses = [
        {id: 'backlog', name: 'Backlog', kind: 'backlog', color: 'slate'},
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
    ] as never
    useNewIssue().open('larder', 'pantry')
})
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
    useNewIssue().close()
})

async function mount() {
    mounted.push(await mountSuspended(NewIssueDialog, {attachTo: document.body}))
    // Headless UI's Dialog draws in a portal on the page's body, not inside the component.
    const wrapper = new DOMWrapper(document.body)
    return wrapper
}

describe('NewIssueDialog', () => {
    it('creates the issue as the owner, in the chunk it was opened on, then closes', async () => {
        const wrapper = await mount()
        await wrapper.find('input[aria-label="Title"]').setValue('  Label the jars ')
        await wrapper.find('textarea').setValue('Flour, sugar, salt\n')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(useNewIssue().target.value).toBeNull())
        expect(sent).toEqual([{path: 'issues', actor: 'skoll', body: {title: 'Label the jars', notes: 'Flour, sugar, salt', chunk: 'pantry', status: 'backlog'}}])
    })

    it('asks a session to pick it up when ticked', async () => {
        const wrapper = await mount()
        await wrapper.find('input[aria-label="Title"]').setValue('Fix the hinge')
        await wrapper.find('input[type="checkbox"]').setValue(true)
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent[1]).toEqual({path: 'focus', actor: 'skoll', body: {note: 'A new issue: please pick it up.'}})
    })

    it('sends nothing without a title, and keeps what was written when it fails', async () => {
        const wrapper = await mount()
        await wrapper.find('input[aria-label="Title"]').setValue('   ')
        await wrapper.find('form').trigger('submit')
        expect(sent).toEqual([])
        failing = true
        await wrapper.find('input[aria-label="Title"]').setValue('Sweep the floor')
        await wrapper.find('form').trigger('submit')
        await vi.waitFor(() => expect(wrapper.text()).toContain('Larder is archived'))
        expect(useNewIssue().target.value).not.toBeNull()
        expect((wrapper.find('input[aria-label="Title"]').element as HTMLInputElement).value).toBe('Sweep the floor')
    })
})
