import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {defineComponent, h} from 'vue'
import type {VueWrapper} from '@vue/test-utils'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, readBody, setResponseStatus} from 'h3'
import {useDemoProject} from '~/composables/useDemoProject'

// The sample project from Getting started: a board with an issue in each status, a sub-issue, two milestones, a
// proposal from Claude and a question from it waiting on the owner.
type Sent = {path: string, actor?: string, body: Record<string, unknown>}
let sent: Sent[] = []
let down = false
let made = 0
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
const post = (path: string, reply: (body: Record<string, unknown>) => object) => registerEndpoint(`/api/projects${path}`, {method: 'POST', handler: async event => {
    const body = await readBody<Record<string, unknown>>(event)
    sent.push({path, actor: getHeader(event, 'orrery-actor'), body})
    if (down) {
        setResponseStatus(event, 500)
        return {}
    }
    return reply(body)
}})
post('', () => ({id: 'demo'}))
post('/demo/milestones', body => ({id: body.title === 'Later' ? 'later' : 'basics'}))
post('/demo/issues', () => ({id: `DEM-${++made}`}))
post('/demo/issues/DEM-8/comments', () => ({id: 1}))

beforeEach(() => {
    sent = []
    down = false
    made = 0
    useOwner().owner.value = {name: 'skoll', display: 'Sköll', named: true}
    useAppSettings().settings.value.statuses = [
        {id: 'proposed', name: 'Proposed', kind: 'proposed', color: 'violet'},
        {id: 'ideas', name: 'Ideas', kind: 'backlog', color: 'gray'},
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
        {id: 'doing', name: 'Doing', kind: 'started', color: 'amber'},
        {id: 'shipped', name: 'Shipped', kind: 'done', color: 'green'},
    ] as never
})
const mounted: VueWrapper[] = []
afterEach(() => mounted.splice(0).forEach(w => w.unmount()))

async function demo() {
    let api!: ReturnType<typeof useDemoProject>
    const wrapper = await mountSuspended(defineComponent(() => {
        api = useDemoProject()
        return () => h('div')
    }))
    mounted.push(wrapper)
    return api
}

describe('useDemoProject', () => {
    it("makes the sample board as the owner, with Claude's proposal and question, in this orrery's statuses", async () => {
        const api = await demo()
        const making = api.make()
        expect(api.making.value).toBe(true)
        await expect(making).resolves.toBe('demo')
        expect(api.making.value).toBe(false)
        expect(api.failed.value).toBe('')

        expect(sent[0]).toMatchObject({path: '', actor: 'skoll', body: {name: 'Demo', id: 'demo', key: 'DEM'}})
        expect(sent.filter(s => s.path === '/demo/milestones').map(s => s.body.title)).toEqual(['Getting around', 'Later'])
        const issues = sent.filter(s => s.path === '/demo/issues')
        expect(issues).toHaveLength(8)
        expect(issues.map(s => s.body.status).filter(Boolean).sort()).toEqual(['doing', 'ideas', 'shipped', 'todo', 'todo', 'todo', 'todo'].sort())
        expect(issues.find(s => s.body.parent)?.body.parent).toBe('DEM-3')
        const proposal = issues.find(s => s.body.proposal === 'pending')!
        expect(proposal.actor).toBe('claude')
        expect(proposal.body.milestone).toBe('later')
        const question = sent.find(s => s.path === '/demo/issues/DEM-8/comments')!
        expect(question).toMatchObject({actor: 'claude', body: {asks: 'decision'}})
    })

    it("says it couldn't make it, once, and is no longer busy", async () => {
        down = true
        const api = await demo()
        await expect(api.make()).resolves.toBeUndefined()
        expect(api.failed.value).toBe("Couldn't make it. Is orrery running?")
        expect(api.making.value).toBe(false)
        expect(sent).toHaveLength(1)
    })
})
