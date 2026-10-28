import {expect, test} from '@playwright/test'
import {AGENT, OWNER, hold, makeProject, projectApi} from './support'

// The session side, with a fake channel and launcher on the API where Claude would be: starting sessions turned on,
// a session's card and a message to it alone, a session across two projects, where a focus goes, several projects
// on one stream, a message to every idle session, Focus on this starting one and New session on this another, Stop on
// one Orrery started, Forget on one that can't hear signals, the session on an issue shown on its page, and a preset.
test.describe.configure({mode: 'serial'})

const api = projectApi('kitchen')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Kitchen', key: 'KIT'})
    await makeProject(request, {name: 'Dairy', key: 'DAI'})
})

test('lets Orrery start sessions once, for every project, on the Sessions page', async ({page, request}) => {
    await page.goto('/sessions#starts')
    const starts = page.locator('#starts')
    await starts.getByRole('checkbox', {name: 'Let Orrery start sessions'}).check()
    await starts.getByLabel('Sessions at once').fill('2')
    await starts.getByLabel('Sessions at once').blur()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).starts).toEqual({limit: 2})
    // A project shows it as its own.
    expect((await api(request, 'get', '')).starts).toEqual({limit: 2})
})

test("shows a listening session on the Sessions page, and sends it a message only it hears", async ({page, request, baseURL}) => {
    const hello = await request.post('/api/sessions', {data: {id: 'e2e-1', project: 'kitchen', event: 'UserPromptSubmit', name: 'kitchen shelves', cwd: '/code/kitchen'}})
    expect(hello.ok(), await hello.text()).toBeTruthy()
    const channel = hold(baseURL!, '/api/projects/kitchen/signals/stream?session=e2e-1&name=kitchen%20shelves&format=text')
    try {
        await page.goto('/sessions')
        const card = page.locator('#session-e2e-1')
        await expect(card).toContainText('kitchen shelves')
        // Listening, so it says nothing about hearing signals.
        await expect(card.getByText("can't hear signals")).toBeHidden()
        await card.getByLabel('Message kitchen shelves').fill('Use the oak hinges, not pine.')
        await card.getByRole('button', {name: 'Send'}).click()
        await expect.poll(() => channel.said.text).toContain('ada_lovelace (to you): Use the oak hinges, not pine.')
        await expect(card.getByText(/message: Use the oak hinges/)).toBeVisible()
    } finally {
        channel.stop()
    }
})

test("forgets a session that can't hear signals, and its next hook brings it back", async ({page, request}) => {
    await request.post('/api/sessions', {data: {id: 'e2e-gone', project: 'kitchen', event: 'Stop', name: 'kitchen drawers'}})
    await page.goto('/sessions')
    const card = page.locator('#session-e2e-gone')
    await expect(card.getByText("can't hear signals")).toBeVisible()
    await expect(card.getByRole('button', {name: 'Stop', exact: true})).toHaveCount(0)
    await card.getByRole('button', {name: 'Forget kitchen drawers'}).click()
    await expect(card).toHaveCount(0)
    await request.post('/api/sessions', {data: {id: 'e2e-gone', project: 'kitchen', event: 'Stop', name: 'kitchen drawers'}})
    await expect(card).toBeVisible()
    await request.post('/api/sessions', {data: {id: 'e2e-gone', project: 'kitchen', event: 'SessionEnd'}})
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
        // Aimed at every session: both do.
        sent.push(await focus('Label the tins', {session: '*'}))
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
    const issue = await api(request, 'post', '/issues', {title: 'Descale the kettle', status: 'todo'})
    const ids = ['e2e-w1', 'e2e-w2']
    for (const id of ids) await request.post('/api/sessions', {data: {id, project: 'kitchen', event: 'SessionStart', name: id}})
    const streams = ids.map(id => hold(baseURL!, `/api/projects/kitchen/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await expect.poll(async () => (await api(request, 'get', '/sessions')).filter((s: {id: string, listening: boolean}) => ids.includes(s.id) && s.listening).length).toBe(2)
        await page.goto(`/p/kitchen/issues/${issue.id}`)
        const chip = page.getByRole('link', {name: /^e2e-w2 ·/})
        await expect(chip).toHaveCount(0)
        // Asked to focus on it, the second one is on it: in the header, and first in the panel, marked.
        await api(request, 'post', `/issues/${issue.id}/focus`, {session: 'e2e-w2'}, OWNER)
        await expect(chip).toBeVisible()
        const rows = page.getByRole('listitem').filter({hasText: /^e2e-w/})
        await expect(rows.first()).toContainText('on this issue')
        await expect(rows.first()).toContainText('e2e-w2')
        await expect(rows.filter({hasText: 'on this issue'})).toHaveCount(1)
        // Gone from the header once it stops listening.
        streams[1]!.stop()
        await expect(chip).toHaveCount(0)
        await expect(page.getByText('on this issue')).toHaveCount(0)
    } finally {
        for (const stream of streams) stream.stop()
    }
})

test('a session Orrery started has Stop out front, asked once more', async ({page, request, baseURL}) => {
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

test('keeps a preset on the Sessions page and offers it in Start session', async ({page}) => {
    await page.goto('/sessions#presets')
    // New preset opens a dialog with the cursor in its text, what a session is told.
    await page.getByRole('button', {name: 'New preset'}).click()
    const writing = page.getByRole('dialog', {name: 'New preset'})
    await expect(writing.getByLabel('What it tells a session')).toBeFocused()
    await page.keyboard.type("You're reviewing: read the diff and comment, don't change code.")
    // Named apart from the Review preset Orrery ships.
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
    // Changed, it can be reset to what Orrery ships.
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
