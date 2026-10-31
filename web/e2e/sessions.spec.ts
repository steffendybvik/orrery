import {expect, test} from '@playwright/test'
import {AGENT, OWNER, hold, makeProject, projectApi} from './support'

// The session side, with a fake channel and launcher on the API where Claude would be: starting sessions turned on,
// a session's card and a message to it alone, a session across two projects, where a focus goes, several projects
// on one stream, a message to every idle session, Focus on this starting one and New session on this another, Stop on
// one orrery started, one with no channel left out of the lists, the session on an issue shown on its page, the repos the
// launcher serves, and a preset.

const api = projectApi('kitchen')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Kitchen', key: 'KIT'})
    await makeProject(request, {name: 'Dairy', key: 'DAI'})
})

test('lets orrery start sessions once, for every project, on the Sessions page', async ({page, request}) => {
    await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
    await page.goto('/sessions#starts')
    const starts = page.locator('#starts')
    await starts.getByRole('checkbox', {name: 'Let orrery start sessions'}).check()
    await starts.getByLabel('Sessions at once').fill('2')
    await starts.getByLabel('Sessions at once').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2})
    // A project shows it as its own.
    expect((await api(request, 'get', '')).starts).toEqual({limit: 2})
    // And keeps a minimum running, up to the limit.
    await starts.getByLabel('Sessions kept running').fill('2')
    await starts.getByLabel('Sessions kept running').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2, min: 2})
    // Work alone can stop starting one, and says so; back on for the tests after this.
    const onSignal = starts.getByRole('checkbox', {name: "Start a session when work arrives and nobody's listening"})
    await onSignal.uncheck()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2, min: 2, on_signal: false})
    await expect(starts.getByText('when you press Start session or Focus on this')).toBeVisible()
    await onSignal.check()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2, min: 2})
    // A limit lowered below the minimum takes it down too, rather than being refused (ORR-479); then back.
    await starts.getByLabel('Sessions at once').fill('1')
    await starts.getByLabel('Sessions at once').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 1, min: 1})
    await expect(starts.getByLabel('Sessions kept running')).toHaveValue('1')
    await starts.getByLabel('Sessions at once').fill('2')
    await starts.getByLabel('Sessions at once').blur()
    await starts.getByLabel('Sessions kept running').fill('2')
    await starts.getByLabel('Sessions kept running').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2, min: 2})
})

test("shows a listening session on the Sessions page, and sends it a message only it hears", async ({page, request, baseURL}) => {
    const hello = await request.post('/api/sessions', {data: {id: 'e2e-1', project: 'kitchen', event: 'UserPromptSubmit', name: 'kitchen shelves', cwd: '/code/kitchen'}})
    expect(hello.ok(), await hello.text()).toBeTruthy()
    const channel = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-1&name=kitchen%20shelves&format=text')
    // What the sessions are on comes in one call for every project, never one with no project in it (ORR-442).
    const asked: string[] = []
    page.on('request', r => {
        if (r.url().includes('/sessions/work')) asked.push(new URL(r.url()).pathname)
    })
    try {
        await page.goto('/sessions')
        const card = page.locator('#session-e2e-1')
        await expect(card).toContainText('kitchen shelves')
        await expect.poll(() => asked).toContain('/api/sessions/work')
        expect(asked.filter(path => path !== '/api/sessions/work')).toEqual([])
        await card.getByLabel('Message kitchen shelves').fill('Use the oak hinges, not pine.')
        await card.getByRole('button', {name: 'Send'}).click()
        await expect.poll(() => channel.said.text).toContain('ada_lovelace (to you): Use the oak hinges, not pine.')
        await expect(card.getByText(/message: Use the oak hinges/)).toBeVisible()
        // ⌘K finds it by name, from any page, and sends the same way, closing once sent (ORR-679).
        await page.goto('/mine')
        await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible()
        await page.keyboard.press('ControlOrMeta+k')
        const palette = page.getByRole('dialog', {name: 'Commands'})
        await palette.getByRole('combobox').fill('>message kitchen')
        await expect(palette.getByRole('option', {name: /Message kitchen shelves/})).toBeVisible()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', {name: 'Message a session'})
        await dialog.getByLabel('Message kitchen shelves').fill('Palette says hello.')
        await dialog.getByRole('button', {name: 'Send'}).click()
        await expect.poll(() => channel.said.text).toContain('(to you): Palette says hello.')
        await expect(dialog).toBeHidden()
        await page.goto('/sessions')
        // ⌘/Ctrl-Enter sends as well, and Shift-Enter is a new line (ORR-514).
        const box = card.getByLabel('Message kitchen shelves')
        await box.fill('Sand first.')
        await box.press('Shift+Enter')
        await box.pressSequentially('Then oil.')
        await expect(box).toHaveValue('Sand first.\nThen oil.')
        await box.press('ControlOrMeta+Enter')
        await expect.poll(() => channel.said.text).toContain('Then oil.')
        await expect(box).toHaveValue('')
    } finally {
        channel.stop()
    }
})

test('leaves a session with no channel out of the lists, with a line on restarting it, until its channel connects', async ({page, request, baseURL}) => {
    // Those the tests before it left behind would count on the line too.
    for (const {id} of await api(request, 'get', '/sessions')) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'SessionEnd'}})
    const issue = await api(request, 'post', '/issues', {title: 'Oil the drawers', status: 'todo'})
    await request.post('/api/sessions', {data: {id: 'e2e-gone', project: 'kitchen', event: 'Stop', name: 'kitchen drawers'}})
    const hint = page.getByText('1 Claude session on Kitchen started without the channel')
    const card = page.locator('#session-e2e-gone')
    const row = page.getByRole('complementary').getByRole('link', {name: /kitchen drawers/})
    try {
        await page.goto('/sessions')
        await expect(hint).toBeVisible()
        await expect(card).toHaveCount(0)
        await expect(row).toHaveCount(0)
        const channel = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-gone&name=kitchen%20drawers&format=text')
        try {
            await expect(card).toBeVisible()
            await expect(row).toBeVisible()
            await expect(hint).toBeHidden()
        } finally {
            channel.stop()
        }
        await expect(card).toHaveCount(0)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        await expect(page.getByText('1 Claude session here started without the channel')).toBeVisible()
        await expect(page.getByRole('link', {name: 'kitchen drawers', exact: true})).toHaveCount(0)
    } finally {
        await request.post('/api/sessions', {data: {id: 'e2e-gone', project: 'kitchen', event: 'SessionEnd'}})
    }
})

test('lists a session that hears two projects once, across them', async ({page, request, baseURL}) => {
    const hello = await request.post('/api/sessions', {data: {id: 'e2e-2', project: 'kitchen', event: 'SessionStart', name: 'stove', cwd: '/code/stove'}})
    expect(hello.ok(), await hello.text()).toBeTruthy()
    const channels = ['kitchen', 'dairy'].map(p => hold(baseURL!, `/api/projects/${p}/signals/stream?session=e2e-2&name=stove&format=text`))
    try {
        await page.goto('/sessions')
        await expect(page.locator('#session-e2e-2')).toHaveCount(1)
        // Under Across projects, with the two it hears (All projects, while they're the only ones).
        await expect(page.locator('#sessions-across #session-e2e-2')).toContainText(/All projects|Kitchen\s*Dairy/)
        // The sidebar (the page's first aside) lists it once too.
        await expect(page.locator('aside').first().getByRole('link', {name: /stove/})).toHaveCount(1)
    } finally {
        for (const channel of channels) channel.stop()
    }
})

test('sends a focus aimed at no session to one, the first free, and to every one when asked', async ({request, baseURL}) => {
    const ids = ['e2e-p1', 'e2e-p2']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/kitchen/signals/stream?session=${id}&name=${id}&format=text`))
    const heard = (title: string) => streams.map(s => s.said.text.includes(title))
    const quiet = () => new Promise(resolve => setTimeout(resolve, 500))
    const focus = async (title: string, body: object) => {
        const issue = await api(request, 'post', '/issues', {title, status: 'todo'})
        return (await api(request, 'post', `/issues/${issue.id}/focus`, body, OWNER)).signal.id as number
    }
    const sent: number[] = []
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(2)
        // Aimed at no session: one of the two idle ones hears it.
        sent.push(await focus('Sort the spices', {}))
        await expect.poll(() => heard('Sort the spices').filter(Boolean).length).toBe(1)
        await quiet()
        expect(heard('Sort the spices').filter(Boolean)).toHaveLength(1)
        // A chunk's, aimed at every session: both do.
        sent.push((await api(request, 'post', '/chunks/all/focus', {note: 'Label the tins', session: '*'}, OWNER)).signal.id as number)
        await expect.poll(() => heard('Label the tins')).toEqual([true, true])
        // With both busy it waits, and goes to the first to go idle.
        for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'UserPromptSubmit'}})
        sent.push(await focus('Wipe the shelf', {}))
        await quiet()
        expect(heard('Wipe the shelf')).toEqual([false, false])
        await request.post('/api/sessions', {data: {id: 'e2e-p2', project: 'kitchen', event: 'Stop'}})
        await expect.poll(() => heard('Wipe the shelf')).toEqual([false, true])
    } finally {
        for (const id of sent) await request.post(`/api/projects/kitchen/signals/${id}/delivered?name=e2e`)
        for (const stream of streams) stream.stop()
    }
})

test('follows several projects on one stream, as one session', async ({request, baseURL}) => {
    const stream = hold(baseURL!, '/api/signals/stream?projects=kitchen,dairy&session=e2e-m&name=multi')
    const multi = async () => (await api(request, 'get', '/sessions')).find((s: {id: string}) => s.id === 'e2e-m')
    try {
        await expect.poll(multi).toMatchObject({listening: true, also: ['dairy']})
        const made = await request.post('/api/projects/dairy/issues', {data: {title: 'Count the jars', status: 'todo'}, headers: AGENT})
        const {id} = await made.json()
        const {signal} = await (await request.post(`/api/projects/dairy/issues/${id}/focus`, {data: {session: 'e2e-m'}, headers: OWNER})).json()
        await expect.poll(() => stream.said.text).toContain('Count the jars')
        expect(stream.said.text).toContain('"project":"dairy"')
        await request.post(`/api/projects/dairy/signals/${signal.id}/delivered?name=multi`)
        // A project that doesn't exist is refused, not followed.
        expect((await request.get('/api/signals/stream?projects=kitchen,nowhere')).status()).toBe(404)
    } finally {
        stream.stop()
    }
    await expect.poll(async () => (await multi())?.listening).toBe(false)
})

test('messages every idle session at once from the Sessions page, not the busy ones', async ({page, request, baseURL}) => {
    const ids = ['e2e-b1', 'e2e-b2']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/kitchen/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(2)
        await request.post('/api/sessions', {data: {id: 'e2e-b2', project: 'kitchen', event: 'UserPromptSubmit'}})
        await page.goto('/sessions')
        await page.getByRole('button', {name: 'Message sessions'}).click()
        const dialog = page.getByRole('dialog', {name: 'Message sessions'})
        await expect(dialog).toContainText('Reaches e2e-b1')
        await dialog.getByLabel('Message', {exact: true}).fill('Pick a Todo issue if you are free.')
        await dialog.getByRole('button', {name: /^Send to 1/}).click()
        await expect(dialog.getByRole('status')).toHaveText('Sent to e2e-b1')
        await expect.poll(() => streams[0]!.said.text).toContain('Pick a Todo issue if you are free.')
        expect(streams[1]!.said.text).not.toContain('Pick a Todo issue')
        // ⌘/Ctrl-Enter sends it too, once.
        await dialog.getByLabel('Message', {exact: true}).fill('Then the next one.')
        await dialog.getByLabel('Message', {exact: true}).press('ControlOrMeta+Enter')
        await expect.poll(() => streams[0]!.said.text).toContain('Then the next one.')
        await page.waitForTimeout(500)
        expect(streams[0]!.said.text.split('Then the next one.').length - 1).toBe(1)
    } finally {
        for (const stream of streams) stream.stop()
    }
})

test('with nobody listening and a launcher there, Focus on this starts a session', async ({page, request, baseURL}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Oil the hinges', status: 'todo'})
    // The session from before has gone: nobody listens on kitchen now.
    await expect.poll(async () => (await api(request, 'get', '/sessions')).some((s: {listening: boolean}) => s.listening)).toBe(false)
    const launcher = hold(baseURL!, '/api/projects/kitchen/launches/stream')
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        await page.getByRole('button', {name: 'Focus on this (starts a session)'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: launch')
    } finally {
        launcher.stop()
    }
})

test('with a session listening, New session on this starts another on the issue', async ({page, request, baseURL}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Sweep the steps', status: 'todo'})
    await request.post('/api/sessions', {data: {id: 'e2e-n1', project: 'kitchen', event: 'SessionStart', name: 'e2e-n1'}})
    const stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-n1&name=e2e-n1&format=text')
    const launcher = hold(baseURL!, '/api/projects/kitchen/launches/stream')
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        await expect(page.getByRole('button', {name: 'Focus on this', exact: true})).toBeVisible()
        await page.getByRole('button', {name: 'New session on this'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: launch')
        // It's the new session's alone: the one listening isn't asked.
        expect(stream.said.text).not.toContain('Sweep the steps')
    } finally {
        launcher.stop()
        stream.stop()
    }
})

test("shows on an issue's page which session is on it, while it listens", async ({page, request, baseURL}) => {
    // Long enough to scroll.
    const notes = Array.from({length: 80}, (_, i) => `Step ${i + 1}: rinse and repeat.`).join('\n\n')
    const issue = await api(request, 'post', '/issues', {title: 'Descale the kettle', status: 'todo', notes})
    const ids = ['e2e-w1', 'e2e-w2']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/kitchen/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(2)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        const banner = page.getByTestId('issue-worker')
        await expect(banner).toHaveCount(0)
        // Asked to focus on it, the second one is on it: in the banner on top, and first in the panel, marked.
        await api(request, 'post', `/issues/${issue.id}/focus`, {session: 'e2e-w2'}, OWNER)
        await expect(banner).toContainText('e2e-w2 is working on this')
        await expect(banner.getByRole('link', {name: 'e2e-w2'})).toHaveAttribute('href', '/sessions#session-e2e-w2')
        // It stays in sight as the page scrolls (ORR-536).
        await page.getByText('Step 80: rinse and repeat.').scrollIntoViewIfNeeded()
        await expect(banner).toBeInViewport()
        const rows = page.getByRole('listitem').filter({hasText: /^e2e-w/})
        await expect(rows.first()).toContainText('on this issue')
        await expect(rows.first()).toContainText('e2e-w2')
        await expect(rows.filter({hasText: 'on this issue'})).toHaveCount(1)
        // The list and the board mark the issue it's working, its name on the dot.
        const dot = page.getByRole('img', {name: 'e2e-w2 is working on it'})
        await page.goto('/p/kitchen?view=board')
        await expect(dot).toHaveCount(1)
        await page.goto('/p/kitchen')
        await expect(dot).toHaveCount(1)
        // Gone from the list once it stops listening, and from the issue's page.
        streams[1]!.stop()
        await expect(dot).toHaveCount(0)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        await expect(page.getByRole('heading', {name: 'Descale the kettle'})).toBeVisible()
        await expect(banner).toHaveCount(0)
        await expect(page.getByText('on this issue')).toHaveCount(0)
    } finally {
        for (const stream of streams) stream.stop()
    }
})

test("a board card's status icon pulses only while its session works, and not with reduced motion", async ({page, request, baseURL}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Scrub the oven', status: 'todo'})
    const report = (event: string) => request.post('/api/sessions', {data: {id: 'e2e-w3', project: 'kitchen', event, name: 'e2e-w3'}})
    await report('SessionStart')
    const stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-w3&name=e2e-w3&format=text')
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).some((s: {id: string, listening: boolean}) => s.id === 'e2e-w3' && s.listening)).toBe(true)
        await page.goto('/p/kitchen?view=board')
        const card = page.locator('[draggable="true"]').filter({hasText: 'Scrub the oven'})
        const icon = card.locator('svg[aria-label]').first()
        const animation = () => icon.evaluate(el => getComputedStyle(el).animationName)
        await expect.poll(animation).toBe('none')
        await api(request, 'post', `/issues/${issue.id}/focus`, {session: 'e2e-w3'}, OWNER)
        await report('UserPromptSubmit')
        await expect.poll(animation).toBe('pulse')
        await page.emulateMedia({reducedMotion: 'reduce'})
        await expect.poll(animation).toBe('none')
        await page.emulateMedia({reducedMotion: 'no-preference'})
        await expect.poll(animation).toBe('pulse')
        // The dot stays, as the session's still on it, but nothing's happening now.
        await report('Stop')
        await expect.poll(animation).toBe('none')
        await expect(page.getByRole('img', {name: 'e2e-w3 is working on it'})).toHaveCount(1)
    } finally {
        stream.stop()
    }
})

test("keeps a session's state that changes as the page opens, over the older read of the sessions", async ({page, request, baseURL}) => {
    const report = (event: string) => request.post('/api/sessions', {data: {id: 'e2e-w4', project: 'kitchen', event, name: 'e2e-w4'}})
    await report('SessionStart')
    const stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-w4&name=e2e-w4&format=text')
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).some((s: {id: string, listening: boolean}) => s.id === 'e2e-w4' && s.listening)).toBe(true)
        // Read while it's idle, and held back until the event saying it works has come.
        let read = () => {}
        const wasRead = new Promise<void>(resolve => read = resolve)
        let release = () => {}
        const released = new Promise<void>(resolve => release = resolve)
        await page.route('**/api/sessions', async route => {
            const response = await route.fetch()
            read()
            await released
            await route.fulfill({response})
        })
        await page.goto('/p/kitchen')
        await wasRead
        await report('UserPromptSubmit')
        const row = page.locator('a[href="/sessions#session-e2e-w4"]').first()
        await expect(row).toContainText('working')
        const landed = page.waitForResponse('**/api/sessions')
        release()
        await (await landed).finished()
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        await expect(row).toContainText('working')
    } finally {
        stream.stop()
    }
})

test('a session orrery started has Stop out front, asked once more', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/kitchen/launches/stream')
    let stream: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await request.post('/api/projects/kitchen/launches/running', {data: {launches: [{id: 'e2e5709e2e57', tmux: 'orrery-e2e-stop'}]}})
        stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-s&name=e2e-started&started=e2e5709e2e57&format=text')
        // On an issue's page its row only points it at the issue; its name leads to the card that manages it.
        const issue = await api(request, 'post', '/issues', {title: 'Wind the clock', status: 'todo'})
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        const row = page.getByRole('listitem').filter({has: page.getByRole('link', {name: 'e2e-started'})})
        await expect(row.getByRole('button', {name: 'Focus on this', exact: true})).toBeVisible()
        await expect(row.getByRole('button', {name: 'Watch'})).toHaveCount(0)
        await expect(row.getByRole('button', {name: 'Stop', exact: true})).toHaveCount(0)
        await row.getByRole('link', {name: 'e2e-started'}).click()
        await expect(page).toHaveURL(/\/sessions#session-e2e-s$/)
        const card = page.locator('#session-e2e-s')
        await expect(card.getByRole('button', {name: 'Watch'})).toBeVisible()
        await card.getByRole('button', {name: 'Stop', exact: true}).click()
        await expect(card).toContainText('Stop e2e-started?')
        await card.getByRole('button', {name: 'Stop', exact: true}).click()
        await expect.poll(() => launcher.said.text).toContain('event: stop')
    } finally {
        stream?.stop()
        launcher.stop()
    }
})

test('+30 minutes tells the launcher, for a session with a stop time', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/kitchen/launches/stream')
    let stream: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        const stops = new Date(Date.now() + 10 * 60_000)
        await request.post('/api/projects/kitchen/launches/running', {data: {launches: [{id: 'e2e30e2e30e2', tmux: 'orrery-e2e-more', stops_at: stops.toISOString()}]}})
        stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-more&name=e2e-timed&started=e2e30e2e30e2&format=text')
        await page.goto('/sessions#session-e2e-more')
        await page.locator('#session-e2e-more').getByRole('button', {name: 'More for e2e-timed'}).click()
        await page.getByRole('menuitem', {name: '+30 minutes'}).click()
        await expect.poll(() => launcher.said.text).toContain('event: extend')
        const sent = /event: extend\ndata: (.*)/.exec(launcher.said.text)![1]!
        expect(Date.parse(JSON.parse(sent).stops_at)).toBeGreaterThan(stops.getTime() + 29 * 60_000)
    } finally {
        stream?.stop()
        launcher.stop()
    }
})

test('lists the repos the launcher serves on Setup, picked up or installed (ORR-605)', async ({page, baseURL}) => {
    const picked = hold(baseURL!, `/api/projects/kitchen/launches/stream?dir=${encodeURIComponent('/code/kitchen')}&picked=${encodeURIComponent(new Date().toISOString())}`)
    const installed = hold(baseURL!, `/api/projects/dairy/launches/stream?dir=${encodeURIComponent('/code/dairy')}`)
    await page.goto('/sessions?tab=setup')
    const repos = page.getByRole('list', {name: 'Repos the launcher serves'})
    await expect(repos.getByRole('listitem').filter({hasText: '/code/kitchen'})).toContainText(/Kitchen\s*picked up/)
    await expect(repos.getByRole('listitem').filter({hasText: '/code/dairy'})).toContainText(/Dairy\s*installed/)
    picked.stop()
    installed.stop()
    await expect(repos).toHaveCount(0)
})

test('keeps a preset on the Sessions page and offers it in Start session', async ({page}) => {
    await page.goto('/sessions#presets')
    // New preset opens a dialog with the cursor in its text, what a session is told.
    await page.getByRole('button', {name: 'New preset'}).click()
    const writing = page.getByRole('dialog', {name: 'New preset'})
    await expect(writing.getByLabel('What it tells a session')).toBeFocused()
    await page.keyboard.type("You're reviewing: read the diff and comment, don't change code.")
    // Named apart from the Review preset orrery ships.
    await writing.getByLabel('Preset name').fill('Close review')
    await writing.getByRole('button', {name: 'Add preset'}).click()
    // A preset is a role card with its badge, name and first line; clicking it opens it in the same dialog.
    await expect(writing).toBeHidden()
    await expect(page.locator('#presets')).toContainText("You're reviewing: read the diff")
    await page.getByRole('button', {name: 'Edit Close review'}).click()
    const editing = page.getByRole('dialog', {name: 'Edit Close review'})
    await expect(editing.getByLabel('Preset name')).toHaveValue('Close review')
    // Its badge is its initials until an icon is picked, behind the badge's button; it's kept as the preset is saved.
    await editing.getByRole('button', {name: 'Badge', exact: true}).click()
    await editing.getByRole('button', {name: 'shield-check', exact: true}).click()
    await expect(editing.getByRole('button', {name: 'Use its initials'})).toBeVisible()
    await editing.getByRole('button', {name: 'Save preset'}).click()
    await expect(editing).toBeHidden()
    await expect(page.getByRole('button', {name: 'New preset'})).toBeVisible()
    // A template says what it's for, and shows its text only on Edit.
    await expect(page.getByLabel('Focus on an issue', {exact: true})).toBeHidden()
    await page.getByRole('button', {name: 'Edit Focus on an issue'}).click()
    await expect(page.getByLabel('Focus on an issue', {exact: true})).toBeVisible()
    await page.goto('/sessions')
    await page.getByRole('button', {name: 'Start session'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'Start session'})
    await expect(dialog).toBeVisible()
    // No launcher is running now, so kitchen can't be picked; the reason says so.
    await expect(dialog.getByRole('group', {name: 'Projects'})).toContainText('No launcher running')
    await page.keyboard.press('Escape')
})

test('ships presets that can be reset to default, and restored once removed', async ({page}) => {
    await page.goto('/sessions#presets')
    const presets = page.locator('#presets')
    await expect(presets.getByRole('button', {name: 'Edit Security audit'})).toBeVisible()
    // Changed, it can be reset to what orrery ships.
    await presets.getByRole('button', {name: 'Edit Debug an error'}).click()
    const editing = page.getByRole('dialog', {name: 'Edit Debug an error'})
    await expect(editing.getByRole('button', {name: 'Reset to default'})).toBeHidden()
    await editing.getByLabel('What it tells a session').fill('Just look.')
    await editing.getByRole('button', {name: 'Save preset'}).click()
    await expect(presets).toContainText('Just look.')
    await presets.getByRole('button', {name: 'Edit Debug an error'}).click()
    await editing.getByRole('button', {name: 'Reset to default'}).click()
    await expect(presets).toContainText("You're looking into an error from the event log")
    // Removed, Restore defaults brings it back.
    await presets.getByRole('button', {name: 'Edit Debug an error'}).click()
    await editing.getByRole('button', {name: 'Remove Debug an error'}).click()
    await expect(presets.getByRole('button', {name: 'Edit Debug an error'})).toBeHidden()
    await presets.getByRole('button', {name: 'Restore defaults'}).click()
    await expect(presets.getByRole('button', {name: 'Edit Debug an error'})).toBeVisible()
    await expect(presets.getByRole('button', {name: 'Restore defaults'})).toBeHidden()
})

test("keeps an issue's id and copy buttons in view: in the panel, or in a bar under the worker's banner (ORR-649)", async ({page, request, baseURL}) => {
    const notes = Array.from({length: 80}, (_, i) => `Step ${i + 1}: strain and pour.`).join('\n\n')
    const issue = await api(request, 'post', '/issues', {title: 'Strain the stock', status: 'todo', notes})
    const row = page.getByTestId('issue-id').locator('visible=true')
    const scroll = () => page.getByText('Step 80: strain and pour.').scrollIntoViewIfNeeded()
    const banner = page.getByTestId('issue-worker')
    const bar = page.getByTestId('issue-id-bar')
    const bottomOf = async (locator: typeof bar) => {
        const box = (await locator.boundingBox())!
        return box.y + box.height
    }
    // Wide: at the top of the panel, one place only, no bar.
    await page.goto(`/p/kitchen/issues/${issue.id}`)
    await expect(row).toHaveCount(1)
    await expect(page.getByRole('complementary').last().getByTestId('issue-id')).toBeVisible()
    await expect(bar).toBeHidden()
    await scroll()
    await expect(row).toBeInViewport()
    await expect(row.getByText('Copy', {exact: true})).toBeVisible()
    // Narrow, with nobody on it: a bar on top.
    await page.setViewportSize({width: 700, height: 600})
    await page.goto(`/p/kitchen/issues/${issue.id}`)
    await expect(row).toHaveCount(1)
    await expect(bar).toBeVisible()
    await scroll()
    await expect(bar).toBeInViewport()
    // With a session on it, the bar sits right under the banner, at one line and at the two a phone wraps it to.
    await request.post('/api/sessions', {data: {id: 'e2e-bar', project: 'kitchen', event: 'SessionStart', name: 'e2e-bar'}})
    const stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-bar&name=e2e-bar&format=text')
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).some((s: {id: string, listening: boolean}) => s.id === 'e2e-bar' && s.listening)).toBe(true)
        await api(request, 'post', `/issues/${issue.id}/focus`, {session: 'e2e-bar'}, OWNER)
        await expect(banner).toBeVisible()
        const heights: number[] = []
        for (const width of [700, 320]) {
            await page.setViewportSize({width, height: 600})
            await scroll()
            await expect(bar).toBeInViewport()
            const barBox = (await bar.boundingBox())!
            expect(Math.abs(barBox.y - await bottomOf(banner))).toBeLessThan(1)
            heights.push((await banner.boundingBox())!.height)
        }
        expect(heights[1]).toBeGreaterThan(heights[0]!)
    } finally {
        stream.stop()
        await request.post('/api/sessions', {data: {id: 'e2e-bar', project: 'kitchen', event: 'SessionEnd'}})
    }
})

test('marks a session cut off by a usage limit until its next turn gets going', async ({page, request, baseURL}) => {
    const say = (data: object) => request.post('/api/sessions', {data: {id: 'e2e-cut', project: 'kitchen', ...data}})
    await say({event: 'SessionStart', name: 'kitchen · Cut'})
    const channel = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-cut&name=kitchen%20%C2%B7%20Cut&format=text')
    try {
        await page.goto('/sessions')
        const row = page.getByRole('complementary').getByRole('link', {name: /Cut/})
        await expect(row).toContainText('idle')
        await say({event: 'StopFailure', error: 'rate_limit', error_text: "You've hit your 5-hour limit · resets 10:20am"})
        await expect(row).toContainText('usage limit reached')
        await expect(page.getByTestId('session-cut-off')).toContainText("usage limit reached: You've hit your 5-hour limit · resets 10:20am")
        await say({event: 'UserPromptSubmit'})
        await expect(row).toContainText('working')
        await expect(page.getByTestId('session-cut-off')).toHaveCount(0)
    } finally {
        channel.stop()
        await say({event: 'SessionEnd'})
    }
})

test('a session opened in a terminal has Stop, asked once more, which ends it through its channel', async ({page, baseURL}) => {
    const channel = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-terminal&name=e2e-terminal&stops=yes')
    try {
        await page.goto('/sessions')
        const card = page.locator('#session-e2e-terminal')
        const stop = card.getByRole('button', {name: 'Stop', exact: true})
        await expect(stop).toBeVisible()
        await expect(card.getByRole('button', {name: 'Show screen'})).toHaveCount(0)
        await stop.click()
        await expect.poll(() => channel.said.text).not.toContain('event: stop')
        await card.getByRole('button', {name: 'Stop it?'}).click()
        await expect.poll(() => channel.said.text).toContain('event: stop')
    } finally {
        channel.stop()
    }
})

test('Show screen draws what the launcher sends, read only, and asks for it only while shown', async ({page, request, baseURL}) => {
    const launcher = hold(baseURL!, '/api/projects/kitchen/launches/stream')
    let stream: ReturnType<typeof hold> | undefined
    try {
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers).toBe(1)
        await request.post('/api/projects/kitchen/launches/running', {data: {launches: [{id: 'e2e5c7ee2e5c', tmux: 'orrery-e2e-screen'}]}})
        stream = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-screen&name=e2e-screen&started=e2e5c7ee2e5c&format=text')
        await page.goto('/sessions')
        const card = page.locator('#session-e2e-screen')
        await expect(card.getByRole('button', {name: 'Show screen'})).toBeVisible()
        expect(launcher.said.text).not.toContain('event: view')
        await card.getByRole('button', {name: 'Show screen'}).click()
        const screen = card.getByLabel("e2e-screen's screen")
        await expect(screen).toHaveText('Waiting for the launcher to send the screen…')
        await expect.poll(() => launcher.said.text).toContain('e2e5c7ee2e5c')
        const sent = await request.post('/api/projects/kitchen/launches/e2e5c7ee2e5c/screen', {data: {screen: '> stirring the soup   \n\n\n'}})
        expect((await sent.json()).watching).toBe(true)
        await expect(screen).toHaveText('> stirring the soup')
        await expect(card.getByText(/^Read only · as of /)).toBeVisible()
        await card.getByRole('button', {name: 'Hide screen'}).click()
        await expect(screen).toHaveCount(0)
    } finally {
        stream?.stop()
        launcher.stop()
    }
})
