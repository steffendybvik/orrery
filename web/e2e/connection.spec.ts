import {expect, test} from '@playwright/test'

// The sidebar says when the live connection is lost, and clears once it's back. A browser's offline switch leaves an open
// stream to localhost alone, so this drives the page's own stream through what it hears when one drops.

test('the sidebar says Reconnecting… and Offline, and clears when the stream is back', async ({page}) => {
    await page.addInitScript(() => {
        const Real = window.EventSource
        window.EventSource = class extends Real {
            constructor(url: string | URL, init?: EventSourceInit) {
                super(url, init)
                if (String(url).includes('/api/events')) (window as unknown as {live: EventSource}).live = this
            }
        }
    })
    const hear = (type: string) => page.evaluate(what => (window as unknown as {live: EventSource}).live.dispatchEvent(new Event(what)), type)
    await page.goto('/mine')
    const sidebar = page.locator('aside')
    await expect(sidebar.getByRole('link', {name: 'My issues'})).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as unknown as {live?: EventSource}).live?.readyState)).toBe(1)

    await hear('error')
    await expect(sidebar.getByText('Reconnecting…')).toBeVisible()
    await hear('open')
    await expect(sidebar.getByText('Reconnecting…')).toHaveCount(0)

    // A stream the browser has given up on stays closed.
    await page.evaluate(() => (window as unknown as {live: EventSource}).live.close())
    await hear('error')
    await expect(sidebar.getByText('Offline')).toBeVisible()
})
