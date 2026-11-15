import type {Locator} from '@playwright/test'
import {expect, test} from './test'
import {hold, makeProject, projectApi} from './support'

// Every session's dot is in its state's colour, on the Sessions page and in the sidebar alike (ORR-1207): a session
// whose channel can't hear (opened without the channel flag) used to lose its colour to a hollow grey ring, so most
// dots didn't tell working from idle.

const api = projectApi('spice-rack')

const colour = (dot: Locator) => dot.locator('[data-session-dot]').evaluate(el => getComputedStyle(el).backgroundColor)
const transparent = ['transparent', 'rgba(0, 0, 0, 0)']

test('a working and an idle session each show their colour, heard or not', async ({page, request, baseURL}) => {
    await makeProject(request, {name: 'Spice rack', key: 'SPR'})
    const report = (id: string, event: string) => request.post('/api/sessions', {data: {id, project: 'spice-rack', event, name: id}})
    const sessions = [
        {id: 'e2e-spice-busy', state: 'working', channel: ''},
        {id: 'e2e-spice-rest', state: 'idle', channel: ''},
        {id: 'e2e-spice-deaf-busy', state: 'working', channel: '&channel=no&stops=yes'},
        {id: 'e2e-spice-deaf-rest', state: 'idle', channel: '&channel=no&stops=yes'},
    ]
    for (const s of sessions) await report(s.id, 'SessionStart')
    const streams = sessions.map(s => hold(baseURL!, `/api/projects/spice-rack/signals/stream?session=${s.id}&name=${s.id}&format=text${s.channel}`))
    try {
        for (const s of sessions) if (s.state === 'working') await report(s.id, 'UserPromptSubmit')
        await expect.poll(async () => (await api(request, 'get', '/sessions'))
            .filter((x: {id: string}) => sessions.some(s => s.id === x.id))
            .map((x: {id: string, state: string, listening: boolean}) => `${x.id} ${x.state} ${x.listening}`).sort())
            .toEqual(sessions.map(s => `${s.id} ${s.state} ${!s.channel}`).sort())

        await page.goto('/sessions')
        const where = {
            'the Sessions page': (id: string) => page.locator(`#session-${id} [data-state]`).first(),
            'the sidebar': (id: string) => page.getByTestId('sidebar-sessions').first().locator(`a[href="/sessions#session-${id}"] [data-state]`),
        }
        for (const [place, dotOf] of Object.entries(where)) {
            const seen: Record<string, string> = {}
            for (const s of sessions) {
                const dot = dotOf(s.id)
                await expect(dot, `${s.id} on ${place}`).toHaveAttribute('data-state', s.state)
                seen[s.id] = await colour(dot)
                expect(transparent, `${s.id} on ${place} has a colour`).not.toContain(seen[s.id])
            }
            // Working and idle aren't the same colour, heard or not; not hearing doesn't change it.
            expect(seen['e2e-spice-busy'], place).not.toBe(seen['e2e-spice-rest'])
            expect(seen['e2e-spice-deaf-busy'], place).toBe(seen['e2e-spice-busy'])
            expect(seen['e2e-spice-deaf-rest'], place).toBe(seen['e2e-spice-rest'])
            await expect(dotOf('e2e-spice-deaf-busy')).toHaveAttribute('title', 'working, not listening')
        }
    } finally {
        for (const s of streams) s.stop()
    }
})
