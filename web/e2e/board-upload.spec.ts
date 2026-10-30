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
