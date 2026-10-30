import {expect, test} from '@playwright/test'
import {AGENT, OWNER, makeProject} from './support'

// A full id over HTTP (ORR-674): found on its own board and server, a 404 anywhere else, and what the copy buttons give.
test('a full id finds its own, and gets a 404 on any other board', async ({page, request, context}) => {
    await makeProject(request, {name: 'Orchard', key: 'ORC'})
    await makeProject(request, {name: 'Vineyard', key: 'ORC'})
    const made = await (await request.post('/api/projects/orchard/issues', {data: {title: 'Prune'}, headers: AGENT})).json()
    await request.post('/api/projects/vineyard/issues', {data: {title: 'Press'}, headers: AGENT})
    const issue = await (await request.get(`/api/projects/orchard/issues/${made.id}`)).json()
    expect(issue.full_id).toMatch(new RegExp(`^${made.id}-[a-z2-7]{8}$`))
    expect((await request.get(`/api/projects/orchard/issues/${issue.full_id}`)).ok()).toBeTruthy()
    expect((await request.get(`/api/projects/vineyard/issues/${issue.full_id}`)).status()).toBe(404)
    expect((await request.post(`/api/projects/orchard/issues/${issue.full_id}/comments`, {data: {body: 'Noted.'}, headers: AGENT})).ok()).toBeTruthy()

    const {uid} = await (await request.get('/api/settings')).json()
    const preset = (await (await request.get('/api/presets')).json())[0]
    const name = preset.name
    expect((await request.patch(`/api/presets/pst-${preset.id}-${uid}`, {data: {name}, headers: OWNER})).ok()).toBeTruthy()
    expect((await request.patch(`/api/presets/pst-${preset.id}-aaaaaaaa`, {data: {name}, headers: OWNER})).status()).toBe(404)

    // The page's button gives the full form, and a pasted one opens the issue.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/p/orchard/issues/${issue.full_id}`)
    await expect(page.getByRole('heading', {level: 1, name: 'Prune'})).toBeVisible()
    await page.getByRole('complementary').last().getByTestId('issue-id').getByRole('button').click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issue.full_id)
})
