import {expect, test} from './test'
import {AGENT, OWNER, hold} from './support'

// The owner letting sessions out of work pick their next issue (ORR-452), on Sessions → Setup, and back off.
test('turns picking the next issue on and off from Sessions → Setup', async ({page, request}) => {
    await page.goto('/sessions?tab=setup')
    const pick = page.getByLabel('Sessions pick their own next issue')
    await expect(pick).not.toBeChecked()
    await pick.check()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).pick_next).toBe(true)
    await page.reload()
    await expect(pick).toBeChecked()
    await pick.uncheck()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).pick_next).toBe(false)
    await request.patch('/api/settings', {data: {pick_next: false}, headers: OWNER})
})

// The whole flow (ORR-1032): a session done with its topic is handed the list and starts the next, and so is one that
// leaves its issue in progress waiting on the owner's answer, as it's done with it for now.
test('a session out of work picks its next issue, and so does one whose issue waits on the owner', async ({request, baseURL}) => {
    const api = async (method: 'get' | 'post' | 'patch' | 'put', path: string, data?: object, headers?: Record<string, string>) => {
        const r = await request[method](`/api${path}`, {data, headers})
        expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
        return r.json()
    }
    if (!(await api('get', '/owner')).named) await api('put', '/owner', {name: 'Ada Lovelace'})
    // Its own names, so a repeat on the same server starts clean.
    const run = Date.now().toString(36)
    const session = `e2e-picker-${run}`
    const as = {'Orrery-Actor': 'claude', 'Orrery-Session': session}
    const slug: string = (await api('post', '/projects', {name: `Orchard ${run}`})).id
    const ids: string[] = []
    // Made in Todo by an agent, which hands nothing out (ORR-515): what the session is sent is its pick list alone.
    for (const title of ['Prune the apples', 'Pick the pears', 'Press the cider']) {
        ids.push((await api('post', `/projects/${slug}/issues`, {title, priority: 'P1', status: 'todo'}, AGENT)).id)
    }
    await request.post('/api/sessions', {data: {id: session, project: slug, event: 'SessionStart', name: session}})
    const stream = hold(baseURL!, `/api/projects/${slug}/signals/stream?session=${session}&name=${session}&format=text`)
    // The note a pick list goes with (PICK_NOTE in server/utils/pick.ts).
    const PICK_NOTE = "You're out of work, so pick your next issue"
    const handed = () => stream.said.text.split(PICK_NOTE).length - 1
    // Its channel says each signal reached it, as the real one does: one unheard would keep it from the next pick.
    const heard = async () => {
        for (const signal of await api('get', `/projects/${slug}/signals`)) {
            await api('post', `/projects/${slug}/signals/${signal.id}/delivered?session=${session}`)
        }
    }
    try {
        await expect.poll(async () => (await api('get', `/projects/${slug}/sessions`)).some((s: {id: string, listening: boolean}) => s.id === session && s.listening)).toBe(true)
        await api('patch', '/settings', {pick_next: true}, OWNER)

        // Its topic, then done: it goes idle and is handed what's left.
        await api('patch', `/projects/${slug}/issues/${ids[0]}`, {status: 'in-progress'}, as)
        await api('patch', `/projects/${slug}/issues/${ids[0]}`, {status: 'done'}, as)
        await request.post('/api/sessions', {data: {id: session, project: slug, event: 'Stop'}})
        await expect.poll(handed, {timeout: 20_000}).toBe(1)
        expect(stream.said.text).toContain(`${ids[1]} (${slug}) [todo, P1] Pick the pears`)
        await heard()

        // It starts the one it picks, asks the owner about it, and goes idle with it still in progress.
        await request.post('/api/sessions', {data: {id: session, project: slug, event: 'UserPromptSubmit'}})
        await api('patch', `/projects/${slug}/issues/${ids[1]}`, {status: 'in-progress'}, as)
        await api('post', `/projects/${slug}/issues/${ids[1]}/comments`, {body: 'Ripe ones only?', asks: 'feedback'}, as)
        await request.post('/api/sessions', {data: {id: session, project: slug, event: 'Stop'}})
        await expect.poll(handed, {timeout: 20_000}).toBe(2)
        expect(stream.said.text.split(PICK_NOTE)[2]).toContain(`${ids[2]} (${slug}) [todo, P1] Press the cider`)
        await api('patch', `/projects/${slug}/issues/${ids[2]}`, {status: 'in-progress'}, as)
        expect((await api('get', `/projects/${slug}/issues/${ids[2]}`)).status).toBe('in-progress')
        // The one waiting on the owner is still its own.
        expect((await api('get', `/projects/${slug}/issues/${ids[1]}`)).status).toBe('in-progress')
    } finally {
        stream.stop()
        await request.patch('/api/settings', {data: {pick_next: false}, headers: OWNER})
    }
})
