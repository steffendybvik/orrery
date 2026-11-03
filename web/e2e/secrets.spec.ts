import {expect, test} from '@playwright/test'

// Secrets on App settings: added with a value that never comes back, a host taken off, and deleted.

const NAME = 'E2E_PANTRY_KEY'

test('adds a secret, shows only its last characters, and deletes it', async ({page, request}) => {
    await page.goto('/settings?tab=orrery#secrets')
    const section = page.locator('#secrets')
    await section.getByRole('button', {name: '+ Add a secret'}).click()
    await section.getByRole('textbox', {name: 'Name'}).fill(NAME)
    await section.getByRole('textbox', {name: 'Value'}).fill('pantry-value-wxyz')
    await section.getByRole('textbox', {name: 'Hosts'}).fill('api.example.com, cdn.example.com')
    await section.locator('form button[type="submit"]').click()

    await expect(section.getByText(NAME)).toBeVisible()
    await expect(section.getByText('••••wxyz')).toBeVisible()
    await expect(section).not.toContainText('pantry-value')
    const listed = async () => (await (await request.get('/api/secrets')).json() as {name: string, hosts: string[]}[]).find(s => s.name === NAME)
    expect(JSON.stringify(await listed())).not.toContain('pantry-value')

    await section.getByRole('button', {name: `Stop ${NAME} going to cdn.example.com`}).click()
    await expect.poll(async () => (await listed())?.hosts).toEqual(['api.example.com'])

    await section.getByRole('button', {name: `Delete ${NAME}`}).click()
    await section.getByRole('button', {name: 'Delete', exact: true}).click()
    await expect(section.getByText(NAME)).toHaveCount(0)
    expect(await listed()).toBeUndefined()
})
