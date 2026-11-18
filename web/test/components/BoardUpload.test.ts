import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {VueWrapper} from '@vue/test-utils'
import {flushPromises} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, getQuery, readRawBody, setResponseStatus} from 'h3'
import BoardUpload from '~/components/BoardUpload.vue'

// A board's file brought in as a new board from App settings (ORR-747, ORR-866, ORR-1248): it uploads as soon as it's
// picked, and an id or key already taken keeps the file waiting while the owner picks others, or cancels. It goes in
// pieces (ORR-1257): its images one by one, the board, then the rest of it into the board.
const sent: {query: Record<string, unknown>, body: string | undefined, actor?: string, type?: string}[] = []
const images: unknown[] = []
registerEndpoint('/api/uploads', {method: 'POST', handler: async event => {
    images.push(JSON.parse(await readRawBody(event) ?? '{}'))
    return {id: 'f'.repeat(24)}
}})
let answers: ('taken' | 'broken' | 'big' | 'made')[] = []
// A write goes as the owner, who the page asks for first.
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/projects/upload', {method: 'POST', handler: async event => {
    sent.push({query: getQuery(event), body: await readRawBody(event), actor: getHeader(event, 'orrery-actor'), type: getHeader(event, 'content-type')})
    const answer = answers.shift()
    // As the server answers a refusal: its status, and why in `message`.
    const refused = (status: number, message: string) => {
        setResponseStatus(event, status)
        return {statusCode: status, message}
    }
    if (answer === 'taken') return refused(409, 'A project with the id shop already exists')
    if (answer === 'broken') return refused(400, 'That file is not a board export')
    if (answer === 'big') return refused(413, 'Payload Too Large')
    return {id: 'shop-2', key: 'SH2', name: 'Shop'}
}})

const mounted: VueWrapper[] = []
afterEach(() => {
    mounted.splice(0).forEach(w => w.unmount())
})
beforeEach(() => {
    sent.splice(0)
    images.splice(0)
    answers = []
})

async function mountUpload() {
    const wrapper = await mountSuspended(BoardUpload)
    mounted.push(wrapper as VueWrapper)
    return wrapper
}
const BOARD = '{"project":"shop","tables":{"projects":[{"id":"shop"}]}}'
/** What goes first for `BOARD`: the board, with nothing after it to send. */
const FIRST = {project: 'shop', uploads: [], tables: {projects: [{id: 'shop'}], comments: [], milestone_comments: [], issue_events: [], doc_revisions: []}}
async function pick(wrapper: VueWrapper, text = BOARD) {
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
        expect(sent.map(s => ({query: s.query, body: JSON.parse(s.body!)}))).toEqual([{query: {}, body: FIRST}])
        // As the owner, which the server asks of an upload, and as JSON (ORR-1299).
        expect(sent[0]).toMatchObject({actor: 'skoll', type: 'application/json'})
        await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/w/default/shop-2'), {timeout: 5000})
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
        expect(sent[1]!.query).toEqual({id: 'shop-2', key: 'SH2'})
        expect(JSON.parse(sent[1]!.body!)).toEqual(FIRST)
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

    it('sends each image on its own, then the board showing it by its id here, then the rest into it', async () => {
        answers = ['made', 'made']
        const wrapper = await mountUpload()
        const shot = 'a'.repeat(24)
        await pick(wrapper, JSON.stringify({project: 'shop', uploads: [{id: shot, data: 'AQID', name: 'shot.png'}],
            tables: {projects: [{id: 'shop'}], comments: [{id: 1, body: `![x](/api/uploads/${shot})`}]}}))
        expect(images).toEqual([{data: 'AQID', name: 'shot.png'}])
        expect(JSON.parse(sent[0]!.body!).uploads).toEqual([])
        expect(sent[1]!.query).toEqual({id: 'shop-2', key: 'SH2', into: '1'})
        expect(JSON.parse(sent[1]!.body!).tables.comments).toEqual([{id: 1, body: `![x](/api/uploads/${'f'.repeat(24)})`}])
        await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/w/default/shop-2'), {timeout: 5000})
    })

    it('says plainly when even the board is refused as too big', async () => {
        answers = ['big']
        const wrapper = await mountUpload()
        await pick(wrapper)
        expect(wrapper.text()).toContain('caps what one request can carry')
    })
})
