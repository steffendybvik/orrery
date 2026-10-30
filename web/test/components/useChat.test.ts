import {beforeEach, describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Chat} from '#shared/roadmap'

// The owner's chat pane (useChat): starting one, the chats heard live winning over a fetch on its way, one ending,
// sending, where its issues land, closing it and pinning its project (ORR-586).
const chat = (id: string, more: Partial<Chat> = {}) => ({id, project: 'greenhouse', issues: 'todo', messages: [], ...more}) as unknown as Chat

let served: Chat[] = []
const posted: {path: string, body: unknown}[] = []
let refuse = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/chats', async event => {
    if (event.method === 'GET') return served
    const body = await readBody(event) as {project: string, issues: Chat['issues']}
    posted.push({path: '/api/chats', body})
    return chat('c2', {project: body.project, issues: body.issues})
})
for (const id of ['c1', 'c2']) {
    registerEndpoint(`/api/chats/${id}/messages`, async event => {
        if (refuse) {
            setResponseStatus(event, 409)
            return {message: refuse}
        }
        posted.push({path: `/api/chats/${id}/messages`, body: await readBody(event)})
        return {}
    })
    registerEndpoint(`/api/chats/${id}/end`, () => {
        posted.push({path: `/api/chats/${id}/end`, body: null})
        return {}
    })
}

beforeEach(() => {
    served = []
    posted.length = 0
    refuse = ''
    localStorage.clear()
    clearNuxtState(['chats', 'chat-open', 'chat-current', 'chat-ended', 'chat-project', 'chat-pinned', 'chat-failed', 'chat-heard', 'chat-large', 'chat-lands', 'owner'])
})

describe('useChat', () => {
    it('starts a chat on the project, where its issues land, and sends a message with the page it was written on', async () => {
        const c = useChat()
        c.show('greenhouse')
        c.land('backlog')
        expect(await c.start()).toBe(true)
        expect(posted[0]).toEqual({path: '/api/chats', body: {project: 'greenhouse', issues: 'backlog'}})
        expect(c.chat.value?.id).toBe('c2')
        expect(await c.send('Hello', [])).toBe(true)
        expect(posted[1]).toMatchObject({path: '/api/chats/c2/messages', body: {text: 'Hello', images: [], page: {path: expect.any(String)}}})
        expect(await c.send(['One', 'two'], [])).toBe(true)
        expect(posted[2]!.body).toMatchObject({parts: ['One', 'two']})
        // Remembered for the next chat.
        expect(localStorage.getItem('orrery-chat-issues')).toBe('backlog')
    })

    it("says why a message didn't go", async () => {
        const c = useChat()
        c.arrived(chat('c1'))
        c.current.value = 'c1'
        refuse = 'No launcher is running for greenhouse'
        expect(await c.send('Hello', [])).toBe(false)
        expect(c.failed.value).toContain('No launcher is running for greenhouse')
    })

    it('keeps a chat heard live over an older one a fetch was bringing, and keeps one that ended on screen', async () => {
        const c = useChat()
        served = [chat('c1', {issues: 'todo'})]
        const fetching = c.fetchChats()
        c.arrived(chat('c1', {issues: 'backlog'}))
        await fetching
        expect(c.chats.value).toEqual([chat('c1', {issues: 'backlog'})])
        expect(c.current.value).toBe('c1')
        c.arrived(chat('c1', {ended: true} as Partial<Chat>))
        expect(c.chats.value).toEqual([])
        expect(c.chat.value).toMatchObject({id: 'c1', ended: true})
        // Nothing goes to an ended chat.
        expect(await c.send('Hello', [])).toBe(false)
        c.fresh()
        expect(c.chat.value).toBeNull()
    })

    it("ends the chat on close, but only hides it on minimize", async () => {
        const c = useChat()
        c.arrived(chat('c1'))
        c.current.value = 'c1'
        c.open.value = true
        c.hide()
        expect(c.open.value).toBe(false)
        expect(c.chat.value?.id).toBe('c1')
        await c.close()
        expect(posted).toEqual([{path: '/api/chats/c1/end', body: null}])
        expect(c.chats.value).toEqual([])
        expect(c.current.value).toBeNull()
    })

    it('follows the page until its project is pinned, and remembers the pin and its size in the browser (ORR-588)', () => {
        const c = useChat()
        c.show('greenhouse')
        c.show('pantry')
        expect(c.project.value).toBe('pantry')
        c.pin('greenhouse')
        c.show('pantry')
        expect(c.project.value).toBe('greenhouse')
        expect(localStorage.getItem('orrery-chat-project')).toBe('greenhouse')
        c.pin(null)
        c.show('pantry')
        expect(c.project.value).toBe('pantry')
        expect(localStorage.getItem('orrery-chat-project')).toBeNull()
        c.resize()
        expect(localStorage.getItem('orrery-chat-large')).toBe('yes')
        c.resize()
        expect(localStorage.getItem('orrery-chat-large')).toBeNull()
    })
})
