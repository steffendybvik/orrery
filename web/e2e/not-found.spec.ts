import {expect, test} from '@playwright/test'
import {makeProject} from './support'

// An unknown URL, project or issue: the same not-found block inside the app, titled so, with a way back.
test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Quarry', key: 'QRY'})
})

test('an unknown URL shows inside the app, and its way back works', async ({page}) => {
    const logged: string[] = []
    page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/events/log') logged.push(request.postData() ?? '')
    })
    await page.goto('/nothing-here')
    await expect(page.getByRole('heading', {name: 'Nothing at /nothing-here'})).toBeVisible()
    // An old or mistyped link isn't an error in Orrery, so the page doesn't log one (ORR-369).
    expect(logged).toEqual([])
    await expect(page).toHaveTitle(/Not found · Orrery$/)
    await expect(page.getByRole('link', {name: 'Quarry'}).first()).toBeVisible()
    await page.getByRole('link', {name: 'Go to My issues'}).click()
    await expect(page).toHaveURL(/\/mine$/)
    await expect(page.getByRole('heading', {name: 'My issues'})).toBeVisible()
})

test('leaving an unknown URL by the sidebar clears it', async ({page}) => {
    await page.goto('/nothing-here')
    await page.getByRole('link', {name: 'Quarry'}).first().click()
    await expect(page).toHaveURL(/\/p\/quarry/)
    await expect(page.getByRole('heading', {name: 'Quarry'})).toBeVisible()
})

test('an unknown project and an unknown issue say what was missing', async ({page}) => {
    await page.goto('/p/nowhere')
    await expect(page.getByRole('heading', {name: 'No project “nowhere”'})).toBeVisible()
    await expect(page.getByText('It may have been renamed or deleted.')).toBeVisible()
    await expect(page).toHaveTitle(/Not found · Orrery$/)

    await page.goto('/p/quarry/issues/QRY-999')
    await expect(page.getByRole('heading', {name: 'No issue QRY-999 in Quarry'})).toBeVisible()
    await expect(page).toHaveTitle(/Not found · Orrery$/)
    await page.getByRole('link', {name: 'Back to Quarry'}).click()
    await expect(page).toHaveURL(/\/p\/quarry$/)
})
