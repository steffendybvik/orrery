import type {APIRequestContext} from '@playwright/test'
import {expect, test} from '@playwright/test'

// An agent's question marks its issue as waiting on the owner (ORR-277): a chip and tint on its row, a list of
// its own on top of My issues, the question quoted on its page; all gone once the owner answers with a comment.
// A project of its own; the owner named if no one has yet.
const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object, headers?: Record<string, string>) => {
    const r = await request[method](`/api${path}`, {data, headers})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

test('an agent\'s question marks its issue as waiting on the owner until they answer', async ({page, request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    await api(request, 'post', '/projects', {name: 'Asks', key: 'ASK'})
    const {id} = await api(request, 'post', '/projects/asks/issues', {title: 'Pick a page size', status: 'in-progress'}, {'Orrery-Actor': 'claude'})
    await api(request, 'post', `/projects/asks/issues/${id}/comments`, {body: 'Should lists show 25 or 50 rows?', asks: 'decision'}, {'Orrery-Actor': 'claude'})
    expect((await api(request, 'get', `/projects/asks/issues/${id}`)).waiting).toBe('decision')

    await page.goto('/p/asks?view=list')
    const row = page.locator(`[data-issue="${id}"]`)
    await expect(row.getByText('Decision needed')).toBeVisible()
    await expect(row).toHaveClass(/waiting-row/)

    await page.goto('/mine')
    await expect(page.getByText('Waiting on you')).toBeVisible()
    await expect(page.locator(`[data-issue="${id}"]`)).toHaveCount(1)

    await page.goto(`/p/asks/issues/${id}`)
    const banner = page.locator('#waiting')
    await expect(banner).toContainText('Should lists show 25 or 50 rows?')
    await banner.getByRole('button', {name: 'Answer'}).click()
    await expect(page.getByRole('textbox', {name: /comment/i}).last()).toBeFocused()
    await page.keyboard.type('50, please')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(banner).toBeHidden()
    expect((await api(request, 'get', `/projects/asks/issues/${id}`)).waiting).toBeUndefined()
    await page.goto('/p/asks?view=list')
    await expect(page.locator(`[data-issue="${id}"]`).getByText('Decision needed')).toBeHidden()
})
