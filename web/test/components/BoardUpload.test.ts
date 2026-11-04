import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {createError, getQuery, readRawBody} from 'h3'
import BoardUpload from '~/components/BoardUpload.vue'

// A board's file brought in as a new board from a project's Settings (ORR-747, ORR-866): it uploads as soon as it's
// picked, and an id or key already taken keeps the file waiting while the owner picks others, or cancels.
const sent: {query: Record<string, unknown>, body: string | undefined}[] = []
let answers: ('taken' | 'broken' | 'made')[] = []
registerEndpoint('/api/projects/upload', {method: 'POST', handler: async event => {
    sent.push({query: getQuery(event), body: await readRawBody(event).catch(e => `ERR ${e}`)})
    const answer = answers.shift()
    if (answer === 'taken') throw createError({statusCode: 409, statusMessage: 'A project with the id shop already exists'})
    if (answer === 'broken') throw createError({statusCode: 400, statusMessage: 'That file is not a board export'})
    return {id: 'shop-2', name: 'Shop'}
}})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
beforeEach(() => {
    sent.splice(0)
    answers = []
})

async function mountUpload() {
    const wrapper = await mountSuspended(BoardUpload)
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
async function pick(wrapper: VueWrapper, text = '{"project":{"id":"shop"}}') {
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {value: [new File([text], 'shop.json', {type: 'application/json'})], configurable: true})
    await input.trigger('change')
    await settle()
}
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
}

describe('uploading a board', () => {
    it('sends the file as soon as it is picked, and opens the new board', async () => {
        answers = ['made']
        const wrapper = await mountUpload()
        await pick(wrapper)
        expect(sent).toEqual([{query: {}, body: '{"project":{"id":"shop"}}'}])
        expect(useRouter().currentRoute.value.path).toBe('/p/shop-2')
        expect(wrapper.find('form').exists()).toBe(false)
    })

    it('asks for another id and key when they are taken, and sends them with the same file', async () => {
        answers = ['taken', 'made']
        const wrapper = await mountUpload()
        await pick(wrapper)
        expect(wrapper.text()).toContain('already exists')
        await wrapper.find('input[aria-label="New id"]').setValue(' shop-2 ')
        await wrapper.find('input[aria-label="New key"]').setValue('sh2')
        expect((wrapper.find('input[aria-label="New key"]').element as HTMLInputElement).value).toBe('SH2')
        await wrapper.find('form').trigger('submit')
        await settle()
        expect(sent[1]).toEqual({query: {id: 'shop-2', key: 'SH2'}, body: '{"project":{"id":"shop"}}'})
        expect(wrapper.find('form').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('already exists')
    })

    it('lets go of the waiting file on Cancel', async () => {
        answers = ['taken']
        const wrapper = await mountUpload()
        await pick(wrapper)
        await wrapper.find('input[aria-label="New id"]').setValue('shop-2')
        await wrapper.findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
        expect(wrapper.find('form').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('already exists')
        expect(sent).toHaveLength(1)
    })

    it("says why a file that isn't a board can't be uploaded, without asking for an id", async () => {
        answers = ['broken']
        const wrapper = await mountUpload()
        await pick(wrapper, 'nope')
        expect(wrapper.text()).toContain('not a board export')
        expect(wrapper.find('form').exists()).toBe(false)
    })
})
