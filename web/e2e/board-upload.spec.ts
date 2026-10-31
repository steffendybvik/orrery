import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

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

    const uploaded = await request.post('/api/projects/upload?id=sawmill&key=SAW&name=Sawmill', {data: file, headers: OWNER})
    expect(uploaded.status()).toBe(201)
    await page.goto(`/p/sawmill/issues/${issue.id}`)
    await expect(page.getByRole('heading', {name: 'Prune the pears'})).toBeVisible()
    await expect(page.getByText('brought it in from a file')).toBeVisible()
})

test('uploads a file from a project\'s settings, asking for another id and key when they\'re taken (ORR-747)', async ({page, request}) => {
    await makeProject(request, {name: 'Quay', key: 'QUA'})
    const issue = await projectApi('quay')(request, 'post', '/issues', {title: 'Tar the hull'})
    const file = await (await request.get('/api/projects/quay/export')).text()

    await page.goto('/p/quay/settings')
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
    await expect(page).toHaveURL(/\/p\/wharf$/)
    await page.goto(`/p/wharf/issues/${issue.id}`)
    await expect(page.getByRole('heading', {name: 'Tar the hull'})).toBeVisible()
    await expect(page.getByText('brought it in from a file')).toBeVisible()
    expect((await (await request.get('/api/projects/quay')).json()).id).toBe('quay')
})
