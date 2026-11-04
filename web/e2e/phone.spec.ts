import {expect, test} from '@playwright/test'

// Open on your phone, in App settings → You (ORR-833). The browser specs' server is on loopback only, so it says how to
// give the phone a port of its own; where it's open, the unit tests (phone.test.ts) say which address it shows.
test("says how to open it on a phone while only this machine can", async ({page}) => {
    await page.goto('/settings?tab=you#phone')
    const section = page.locator('#phone')
    await expect(section.getByRole('heading', {name: 'Open on your phone'})).toBeVisible()
    await expect(section.getByText('Only this machine can open it now.')).toBeVisible()
    await expect(section.getByText('ORRERY_PHONE_PORT')).toBeVisible()
})

// Signed in, under it (ORR-838): each browser and phone with a login, to end a lost one. The browser specs' server has
// login off and nobody signed in, so it says so.
test('lists the logins, with none yet', async ({page}) => {
    await page.goto('/settings?tab=you#logins')
    const section = page.locator('#logins')
    await expect(section.getByRole('heading', {name: 'Signed in'})).toBeVisible()
    await expect(section.getByText('Nothing is signed in: no browser or phone has a login.')).toBeVisible()
})
