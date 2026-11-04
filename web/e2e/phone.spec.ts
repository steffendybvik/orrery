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

// Where it's open, the Mac's Bonjour name leads (ORR-874), saying a phone that can't find it has the IPs under it. The
// specs' server can't be opened to the network, so this answers `GET /api/phone` as an open one on a Mac would.
test("leads with the Mac's .local name where it's open, the IPs under it", async ({page}) => {
    await page.route('**/api/phone', route => route.fulfill({json: {reach: 'network', docker: false, port: '19000', phone: false, addresses: [
        {url: 'http://steffens-mac.local:19000', from: 'machine', name: true},
        {url: 'http://192.168.178.90:19000', from: 'machine'},
    ]}}))
    await page.goto('/settings?tab=you#phone')
    const section = page.locator('#phone')
    await expect(section.getByRole('img', {name: 'QR code for http://steffens-mac.local:19000'})).toBeVisible()
    await expect(section.getByText("is this machine's name on the Wi-Fi")).toBeVisible()
    await section.getByRole('button', {name: 'Show the QR code for http://192.168.178.90:19000'}).click()
    await expect(section.getByRole('img', {name: 'QR code for http://192.168.178.90:19000'})).toBeVisible()
    await expect(section.getByText("is this machine's name on the Wi-Fi")).toBeHidden()
})
