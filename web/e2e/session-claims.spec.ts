import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// An issue one listening session has started is that session's (ORR-287): another session's comment or edit on it is
// refused, not only starting it, while the owner's go through; and a chunk's list tells the other session to skip it.
// A project of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'patch' | 'put', path: string, data?: object, headers?: Record<string, string>) => {
    const r = await request[method](`/api${path}`, {data, headers})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

function hold(baseURL: string, path: string) {
    const controller = new AbortController()
    const said = {text: ''}
    fetch(`${baseURL}${path}`, {signal: controller.signal}).then(async response => {
        const reader = response.body!.getReader()
        for (;;) {
            const {done, value} = await reader.read()
            if (done) return
            said.text += new TextDecoder().decode(value)
        }
    }).catch(() => {})
    return {said, stop: () => controller.abort()}
}

test("keeps an issue to the session on it: another's comment and edit are refused, and its list says to skip it", async ({request, baseURL}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    const OWNER = {'Orrery-Actor': (await api(request, 'get', '/owner')).name}
    await api(request, 'post', '/projects', {name: 'Cellar', key: 'CEL'})
    const as = (session: string) => ({'Orrery-Actor': 'claude', 'Orrery-Session': session})
    const ids = ['e2e-c1', 'e2e-c2']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'cellar', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/cellar/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/cellar/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(2)
        const {id} = await api(request, 'post', '/projects/cellar/issues', {title: 'Rack the wine', status: 'todo'}, OWNER)
        await api(request, 'patch', `/projects/cellar/issues/${id}`, {status: 'in-review'}, as('e2e-c1'))

        // The other session: no comment, no edit, no start.
        const refused = await request.post(`/api/projects/cellar/issues/${id}/comments`, {data: {body: 'On it too'}, headers: as('e2e-c2')})
        expect(refused.status()).toBe(409)
        expect(await refused.text()).toContain('already being worked on by another session (e2e-c1)')
        expect((await request.patch(`/api/projects/cellar/issues/${id}`, {data: {title: 'Mine now'}, headers: as('e2e-c2')})).status()).toBe(409)
        // Its own session and the owner may.
        await api(request, 'post', `/projects/cellar/issues/${id}/comments`, {body: 'Racked the reds'}, as('e2e-c1'))
        await api(request, 'post', `/projects/cellar/issues/${id}/comments`, {body: 'Whites next'}, OWNER)

        // A chunk's list marks it for the other session only.
        await api(request, 'post', '/projects/cellar/chunks/all/focus', {session: '*'}, OWNER)
        await expect.poll(() => streams.map(s => s.said.text.includes('Rack the wine'))).toEqual([true, true])
        const line = (text: string) => text.split('\n').find(l => l.includes(`${id}: Rack the wine`))
        expect(line(streams[1]!.said.text)).toContain('another session is on it')
        expect(line(streams[0]!.said.text)).not.toContain('another session is on it')
    } finally {
        for (const stream of streams) stream.stop()
    }
})

test('gives an issue to one session only when several start it at the same moment (ORR-328)', async ({request, baseURL}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    const OWNER = {'Orrery-Actor': (await api(request, 'get', '/owner')).name}
    await api(request, 'post', '/projects', {name: 'Buttery', key: 'BTY'})
    const as = (session: string) => ({'Orrery-Actor': 'claude', 'Orrery-Session': session})
    const ids = ['e2e-r1', 'e2e-r2', 'e2e-r3', 'e2e-r4']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'buttery', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/buttery/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await expect.poll(async () => (await api(request, 'get', '/projects/buttery/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(ids.length)
        for (let round = 0; round < 3; round++) {
            const {id} = await api(request, 'post', '/projects/buttery/issues', {title: `Jars, round ${round + 1}`, status: 'todo'}, OWNER)
            // Every session starts it at once, as start_issue does: status and assignee in one write.
            const answers = await Promise.all(ids.map(session =>
                request.patch(`/api/projects/buttery/issues/${id}`, {data: {status: 'started', assignee: 'claude'}, headers: as(session)})))
            const statuses = answers.map(a => a.status())
            expect(statuses.filter(s => s === 200)).toHaveLength(1)
            expect(statuses.filter(s => s === 409)).toHaveLength(ids.length - 1)
            const winner = ids[statuses.indexOf(200)]!
            // The others can't comment on it, as start_issue's comment would; the winner can.
            for (const session of ids.filter(s => s !== winner)) {
                expect((await request.post(`/api/projects/buttery/issues/${id}/comments`, {data: {body: 'Me too'}, headers: as(session)})).status()).toBe(409)
            }
            await api(request, 'post', `/projects/buttery/issues/${id}/comments`, {body: 'On it'}, as(winner))
        }
    } finally {
        for (const stream of streams) stream.stop()
    }
})
