import {expect, test} from '@playwright/test'

// Open on your phone, in App settings → You (ORR-833). The browser specs' server is on loopback only, so it says what
// opening it up takes, claiming first; where it's open, the unit tests (phone.test.ts) say which address it shows.
test("says how to open it on a phone while only this machine can", async ({page}) => {
    await page.goto('/settings?tab=you#phone')
    const section = page.locator('#phone')
    await expect(section.getByRole('heading', {name: 'Open on your phone'})).toBeVisible()
    await expect(section.getByText('Only this machine can open it now.')).toBeVisible()
    await expect(section.getByRole('link', {name: 'Claim it'})).toHaveAttribute('href', '#claim')
    await expect(section.getByText('ORRERY_HOST=0.0.0.0').or(section.getByText('HOST=0.0.0.0'))).toBeVisible()
})
