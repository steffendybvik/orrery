import {expect, test} from './test'
import {AGENT, OWNER, hold, makeProject, projectApi} from './support'

// A board's file brought in as a new board, through the real route (ORR-670); what it does with a file is in board-upload.test.ts.
const api = projectApi('boathouse')

test('uploads a board\'s export as a new board, which opens with its issues, and an agent can\'t', async ({page, request}) => {
    await makeProject(request, {name: 'Boathouse', key: 'BOH'})
    const issue = await api(request, 'post', '/issues', {title: 'Prune the pears'})
    const file = await (await request.get('/api/projects/boathouse/export')).json()

    const taken = await request.post('/api/projects/upload', {data: file, headers: OWNER})
    expect(taken.status()).toBe(409)
    const agent = await request.post('/api/projects/upload?id=sawmill&key=SAW', {data: file, headers: {'Orrery-Actor': 'claude'}})
    expect(agent.status()).toBe(403)

    // A retry's board has its own id and key, as the first try may have made Sawmill already.
    const [id, key] = test.info().retry ? ['sawmill-again', 'SWA'] : ['sawmill', 'SAW']
    const uploaded = await request.post(`/api/projects/upload?id=${id}&key=${key}&name=Sawmill`, {data: file, headers: OWNER})
    expect(uploaded.status()).toBe(201)
    await page.goto(`/p/${id}/issues/${issue.id}`)
    await expect(page.getByRole('heading', {name: 'Prune the pears'})).toBeVisible()
    await expect(page.getByText('brought it in from a file')).toBeVisible()
})

test('uploads a file from App settings, asking for another id and key when they\'re taken (ORR-747, ORR-1248)', async ({page, request}) => {
    await makeProject(request, {name: 'Quay', key: 'QUA'})
    const issue = await projectApi('quay')(request, 'post', '/issues', {title: 'Tar the hull'})
    const file = await (await request.get('/api/projects/quay/export')).text()

    await page.goto('/settings#upload')
    const upload = page.locator('#upload')
    await expect(upload.getByLabel('Upload a board…')).toBeAttached()

    // Not a board's file: it says so and nothing's asked.
    await upload.getByLabel('Upload a board…').setInputFiles({name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json')})
    await expect(upload.getByText("That isn't a board's file")).toBeVisible()
    await expect(upload.getByLabel('New id')).toHaveCount(0)

    // Its own id is taken, so it asks; and a free one opens the new board.
    await upload.getByLabel('Upload a board…').setInputFiles({name: 'quay.orrery.json', mimeType: 'application/json', buffer: Buffer.from(file)})
    await expect(upload.getByLabel('New id')).toBeVisible()
    await upload.getByLabel('New id').fill('wharf')
    await upload.getByLabel('New key').fill('wrf')
    await upload.getByRole('button', {name: 'Upload', exact: true}).click()
    await expect(page).toHaveURL(/\/wharf$/)
    await page.goto(`/p/wharf/issues/${issue.id}`)
    await expect(page.getByRole('heading', {name: 'Tar the hull'})).toBeVisible()
    await expect(page.getByText('brought it in from a file')).toBeVisible()
    expect((await (await request.get('/api/projects/quay')).json()).id).toBe('quay')
})

test('brings a board\'s comments, pictures and docs along with its issues (ORR-1209)', async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    await makeProject(request, {name: 'Cooperage', key: 'COO'})
    const coop = projectApi('cooperage')
    const issue = await coop(request, 'post', '/issues', {title: 'Hoop the barrels'})
    const picture = await (await request.post('/api/uploads', {data: {name: 'barrel.png', data: png}, headers: AGENT})).json() as {url: string}
    await coop(request, 'post', `/issues/${issue.id}/comments`, {body: `Three done:\n\n![The barrels](${picture.url})`})
    await coop(request, 'post', '/docs', {title: 'Staves', body: 'Oak, quarter-sawn.'})
    const file = await (await request.get('/api/projects/cooperage/export?uploads=1')).json()
    expect(file.uploads.map((u: {id: string}) => `/api/uploads/${u.id}`)).toEqual([picture.url])

    const [id, key] = test.info().retry ? ['tun-again', 'TUA'] : ['tun', 'TUN']
    expect((await request.post(`/api/projects/upload?id=${id}&key=${key}&name=Tun`, {data: file, headers: OWNER})).status()).toBe(201)
    const tun = projectApi(id)
    const comments = await tun(request, 'get', `/issues/${issue.id}/comments`) as {body: string, created_by: string}[]
    expect(comments).toEqual([expect.objectContaining({body: `Three done:\n\n![The barrels](${picture.url})`, created_by: 'claude (from a file)'})])
    const docs = await tun(request, 'get', '/docs') as {id: string, title: string}[]
    const staves = docs.find(d => d.title === 'Staves')
    expect((await tun(request, 'get', `/docs/${staves!.id}`)).body).toBe('Oak, quarter-sawn.')

    await page.goto(`/p/${id}/issues/${issue.id}`)
    await expect(page.getByRole('img', {name: 'The barrels'})).toBeVisible()
    await expect(page.getByRole('img', {name: 'The barrels'})).toHaveJSProperty('naturalWidth', 1)
})

test("holds an uploaded board's Todo out of a session's pick list till the owner lets sessions pick from it (ORR-1224)", async ({page, request, baseURL}) => {
    // A retry starts from a board of its own: the first try's issue would be on the upload too.
    const [from, fromKey, id, key] = test.info().retry ? ['chandlery-again', 'CHB', 'ropewalk-again', 'RWA'] : ['chandlery', 'CHA', 'ropewalk', 'RWK']
    await makeProject(request, {name: from, key: fromKey})
    const issue = await projectApi(from)(request, 'post', '/issues', {title: 'Coil the rope', status: 'todo'})
    const file = await (await request.get(`/api/projects/${from}/export`)).json()
    const uploaded = await request.post(`/api/projects/upload?id=${id}&key=${key}&name=Ropewalk`, {data: file, headers: OWNER})
    expect(uploaded.status(), await uploaded.text()).toBe(201)

    const session = `e2e-pick-${id}`
    const stream = hold(baseURL!, `/api/projects/${id}/signals/stream?session=${session}&name=${session}&format=text`)
    try {
        await expect.poll(async () => (await (await request.get('/api/sessions')).json() as {id: string, listening: boolean}[])
            .some(s => s.id === session && s.listening)).toBe(true)
        const offered = async () => (await (await request.get(`/api/projects/${id}/sessions/${session}/next`)).json() as {issues: {id: string}[]}).issues.map(i => i.id)
        expect(await offered()).toEqual([])

        await page.goto(`/p/${id}/settings`)
        const picks = page.locator('#picks')
        await expect(picks.getByText('came from a file')).toBeVisible()
        await picks.getByRole('button', {name: 'Let sessions pick from this board'}).click()
        await expect(picks).toHaveCount(0)
        await expect.poll(offered).toEqual([issue.id])
    } finally {
        stream.stop()
    }
})
