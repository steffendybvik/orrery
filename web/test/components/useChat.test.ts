import {beforeEach, describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody, setResponseStatus} from 'h3'
import type {Chat} from '#shared/roadmap'

// The owner's chat pane (useChat): starting one, the chats heard live winning over a fetch on its way, one ending,
// sending, where its issues land, closing it and pinning its project (ORR-586), and the list of chats (ORR-870).
const chat = (id: string, more: Partial<Chat> = {}) => ({id, project: 'greenhouse', started_at: `2026-11-04T10:00:0${id.slice(1)}Z`, issues: 'todo', messages: [], ...more}) as unknown as Chat
let made = 2

let served: Chat[] = []
const posted: {path: string, body: unknown}[] = []
let refuse = ''
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Skoll', named: true}))
registerEndpoint('/api/chats', async event => {
    if (event.method === 'GET') return served
    const body = await readBody(event) as {project: string, issues: Chat['issues']}
    posted.push({path: '/api/chats', body})
    return chat(`c${made++}`, {project: body.project, issues: body.issues})
})
for (const id of ['c1', 'c2', 'c3']) {
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
    made = 2
    posted.length = 0
    refuse = ''
    localStorage.clear()
    clearNuxtState(['chats', 'chat-open', 'chat-picked', 'chat-blank', 'chat-project', 'chat-pinned', 'chat-failed', 'chat-heard', 'chat-large', 'chat-lands', 'owner'])
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
        c.show('greenhouse')
        c.arrived(chat('c1'))
        refuse = 'No launcher is running for greenhouse'
        expect(await c.send('Hello', [])).toBe(false)
        expect(c.failed.value).toContain('No launcher is running for greenhouse')
    })

    it('keeps a chat heard live over an older one a fetch was bringing, and keeps one that ended on screen, to write in again', async () => {
        const c = useChat()
        c.show('greenhouse')
        served = [chat('c1', {issues: 'todo'})]
        const fetching = c.fetchChats()
        c.arrived(chat('c1', {issues: 'backlog'}))
        await fetching
        expect(c.chats.value).toEqual([chat('c1', {issues: 'backlog'})])
        expect(c.chat.value?.id).toBe('c1')
        c.view('c1')
        c.arrived(chat('c1', {ended: true}))
        expect(c.chats.value).toEqual([chat('c1', {ended: true})])
        expect(c.running.value).toEqual([])
        expect(c.chat.value).toMatchObject({id: 'c1', ended: true})
        // Writing in an ended chat goes to it, which starts its session again (ORR-884).
        expect(await c.send('Hello', [])).toBe(true)
        expect(posted.at(-1)).toMatchObject({path: '/api/chats/c1/messages', body: {text: 'Hello'}})
        c.fresh()
        expect(c.chat.value).toBeNull()
    })

    it('leaves the chat running on close and on minimize; only end ends it, keeping it in the list (ORR-878)', async () => {
        const c = useChat()
        c.show('greenhouse')
        c.arrived(chat('c1'))
        c.hide()
        expect(c.open.value).toBe(false)
        expect(c.chat.value?.id).toBe('c1')
        c.show('greenhouse')
        c.close()
        expect(c.open.value).toBe(false)
        expect(posted).toEqual([])
        expect(c.chat.value).toMatchObject({id: 'c1'})
        expect(c.chat.value?.ended).toBeFalsy()
        await c.end('c1')
        expect(posted).toEqual([{path: '/api/chats/c1/end', body: null}])
        expect(c.chats.value).toMatchObject([{id: 'c1', ended: true}])
        // The ended one is a click away, to read; closed, the pane lets it go, ready for a fresh one.
        c.view('c1')
        expect(c.chat.value).toMatchObject({id: 'c1', ended: true})
        c.close()
        expect(c.chat.value).toBeNull()
        c.view('c1')
        expect(c.chat.value).toMatchObject({id: 'c1', ended: true})
    })

    it('holds as many chats as the owner starts, several on one project, each a click away (ORR-870)', async () => {
        const c = useChat()
        served = [chat('c1')]
        c.show('greenhouse')
        await c.fetchChats()
        expect(c.chat.value?.id).toBe('c1')
        // New chat on the same project: a fresh one, with c1 still running.
        c.fresh()
        expect(c.chat.value).toBeNull()
        expect(await c.start()).toBe(true)
        expect(c.chat.value).toMatchObject({id: 'c2', project: 'greenhouse'})
        // And one on another project.
        c.switchTo('pantry')
        expect(c.chat.value).toBeNull()
        expect(await c.start()).toBe(true)
        expect(c.chat.value).toMatchObject({id: 'c3', project: 'pantry'})
        // Newest first, all running.
        expect(c.chats.value.map(x => x.id)).toEqual(['c3', 'c2', 'c1'])
        expect(c.running.value).toHaveLength(3)
        // One click opens any, on its project, each as it was.
        c.view('c1')
        expect(c.project.value).toBe('greenhouse')
        expect(c.chat.value?.id).toBe('c1')
        c.view('c3')
        expect(c.chat.value?.id).toBe('c3')
        // Pinned, opening one moves the pin.
        c.pin('pantry')
        c.view('c2')
        expect(c.pinned.value).toBe('greenhouse')
        // A row's × ends only that one; it stays listed, ended.
        await c.end('c1')
        expect(posted.filter(p => p.path.endsWith('/end'))).toEqual([{path: '/api/chats/c1/end', body: null}])
        expect(c.running.value.map(x => x.id)).toEqual(['c3', 'c2'])
        expect(c.chats.value.find(x => x.id === 'c1')).toMatchObject({ended: true})
        expect(c.chat.value?.id).toBe('c2')
        // Moving to a project shows its newest running chat.
        c.pin(null)
        c.switchTo('pantry')
        expect(c.chat.value?.id).toBe('c3')
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
