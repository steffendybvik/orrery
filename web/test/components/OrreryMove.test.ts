import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import OrreryMove from '~/components/OrreryMove.vue'

// Moving a workspace to another orrery from App settings (ORR-1249): a preview that writes nothing, then the move,
// followed till it ends, then marking the boards here as moved.
const asked: Record<string, unknown>[] = []
const marked: unknown[] = []
let polls = 0
let refuse = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/orrery-moves', {method: 'POST', handler: async event => {
    const body = await readBody(event)
    asked.push(body)
    if (refuse) {
        setResponseStatus(event, 400)
        return {statusCode: 400, message: refuse}
    }
    if (body.dryRun) return {summary: 'Dry run: nothing was written to https://o.example.com.', report: {projects: []}}
    setResponseStatus(event, 202)
    return {id: 'run-1'}
}})
registerEndpoint('/api/orrery-moves/run-1', () => {
    polls++
    return polls < 2
        ? {state: 'running', progress: {step: 'uploading', project: 'home', done: 0, total: 1}, lines: []}
        : {state: 'done', lines: [], summary: 'Brought it in.', report: {workspace: {id: 'personal', name: 'Personal'}, projects: [{from: 'home', id: 'home', key: 'HOM', name: 'home'}]}}
})
registerEndpoint('/api/projects/home/moved', {method: 'PUT', handler: async event => {
    marked.push(await readBody(event))
    return {}
}})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
beforeEach(() => {
    asked.splice(0)
    marked.splice(0)
    polls = 0
    refuse = ''
})
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}
async function filled() {
    const wrapper = await mountSuspended(OrreryMove)
    mounted.push(wrapper as VueWrapper)
    await wrapper.find('input[type="url"]').setValue('https://o.example.com')
    await wrapper.find('input[type="password"]').setValue('orrery_person_k')
    await wrapper.find('input[required]:not([type])').setValue('Personal')
    return wrapper
}
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find(b => b.text().includes(text))!

describe('moving a workspace', () => {
    it('previews, moves, follows it and marks the boards here as moved', async () => {
        const wrapper = await filled()
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(asked.at(-1)).toMatchObject({direction: 'send', url: 'https://o.example.com', key: 'orrery_person_k', name: 'Personal', dryRun: true})
        expect(wrapper.text()).toContain('Dry run: nothing was written')

        await button(wrapper, 'Move it').trigger('click')
        await vi.waitFor(async () => {
            await flushPromises()
            expect(wrapper.text()).toContain('Moved.')
        }, {timeout: 5000})
        expect(asked.at(-1)).not.toHaveProperty('dryRun')
        expect(wrapper.find('a[href="https://o.example.com/w/personal/mine"]').exists()).toBe(true)

        await button(wrapper, 'Mark as moved').trigger('click')
        await settle()
        expect(marked).toEqual([{to: 'https://o.example.com/w/personal/p/home'}])
        expect(wrapper.text()).toContain('marked as moved')
    })

    it('says why inline when the server refuses', async () => {
        refuse = "https://o.example.com didn't take that key"
        const wrapper = await filled()
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(wrapper.find('.text-rose-700').text()).toContain("didn't take that key")
    })
})
