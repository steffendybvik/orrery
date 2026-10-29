import {expect, test} from '@playwright/test'
import {OWNER, makeProject} from './support'

// The Pull requests page's Poll (ORR-534): GitHub asked at once, and a repo read without a token a moment ago held back,
// saying when it can be asked again. Whatever GitHub answers for the made-up repo, the second ask is held.
test('polls now on Poll, and holds a repo without a token for a minute', async ({page, request}) => {
    await makeProject(request, {name: 'Pantry', key: 'PAN'})
    const set = await request.patch('/api/projects/pantry', {data: {repo: 'https://github.com/orrery-e2e/pantry'}, headers: OWNER})
    expect(set.ok(), await set.text()).toBeTruthy()
    await page.goto('/pulls')
    const pollButton = page.getByRole('button', {name: 'Poll', exact: true})
    await expect(pollButton).toBeEnabled()
    await pollButton.click()
    await expect(pollButton).toBeEnabled({timeout: 20_000})
    await pollButton.click()
    await expect(page.getByRole('list', {name: 'Repos'})).toContainText('not polled now: Read without a token a moment ago')
    // Only the owner polls.
    expect((await request.post('/api/pulls/poll', {headers: {'Orrery-Actor': 'claude'}})).status()).toBe(403)
})
