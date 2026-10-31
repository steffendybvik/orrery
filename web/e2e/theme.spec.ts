import {expect, test} from '@playwright/test'

// The button in every page's header: light and dark, kept in this browser. Until it's pressed, the page follows the system.

test('the toggle switches between light and dark, and it stays', async ({page}) => {
    await page.emulateMedia({colorScheme: 'light'})
    await page.goto('/mine')
    const root = page.locator('html')
    await expect(root).not.toHaveClass(/\bdark\b/)

    await page.getByRole('button', {name: 'Switch to dark'}).click()
    await expect(root).toHaveClass(/\bdark\b/)
    await page.reload()
    await expect(root).toHaveClass(/\bdark\b/)
    await expect(page.getByRole('button', {name: 'Switch to light'})).toBeVisible()
    // Picked, it no longer follows the system.
    await page.emulateMedia({colorScheme: 'dark'})
    await page.emulateMedia({colorScheme: 'light'})
    await expect(root).toHaveClass(/\bdark\b/)

    await page.getByRole('button', {name: 'Switch to light'}).click()
    await expect(root).not.toHaveClass(/\bdark\b/)
})

test('until one is picked, the page follows the system as it changes', async ({page}) => {
    await page.emulateMedia({colorScheme: 'dark'})
    await page.goto('/mine')
    const root = page.locator('html')
    await expect(root).toHaveClass(/\bdark\b/)
    // It listens from when the button is on the page.
    await expect(page.getByRole('button', {name: 'Switch to light'})).toBeVisible()
    await page.emulateMedia({colorScheme: 'light'})
    await expect(root).not.toHaveClass(/\bdark\b/)
})
