import {expect, test} from '@playwright/test'

// App settings by what they reach (ORR-285): You, Issues (every project) and This orrery, each tab saying so; a link
// to a section opens its tab. Which terminal Watch opens is with the sessions, under Sessions → Setup.
test('splits App settings into tabs by what they reach, and a link opens the right one', async ({page}) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', {name: 'Your name'})).toBeVisible()
    await expect(page.getByText('Who you are on this orrery')).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Issue statuses'})).toHaveCount(0)

    await page.getByRole('radio', {name: 'Issues'}).click()
    await expect(page).toHaveURL(/tab=issues/)
    await expect(page.getByText('How issues work in every project on this orrery')).toBeVisible()
    for (const name of ['Team tracker', 'Issue statuses', 'Proposals']) await expect(page.getByRole('heading', {name})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Your name'})).toHaveCount(0)

    await page.goto('/settings#tint')
    for (const name of ['Background tint', 'Secrets', 'Database']) await expect(page.getByRole('heading', {name})).toBeVisible()
    await expect(page.getByRole('heading', {name: 'Watching sessions'})).toHaveCount(0)

    await page.goto('/sessions#watch')
    await expect(page.getByRole('heading', {name: 'Watching sessions'})).toBeVisible()
    await expect(page.getByLabel('Terminal app')).toBeVisible()
})
