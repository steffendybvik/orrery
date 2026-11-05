import AxeBuilder from '@axe-core/playwright'
import type {Page} from '@playwright/test'
import {expect, test} from './test'
import type {Walked} from './pages'
import {ROUTES, heading} from './pages'

// What the read-only page walks share (ORR-920): wcag-light.spec.ts, wcag-dark.spec.ts and a11y.spec.ts, each a file, and
// a project, of its own, so a shard of the suite can take them apart and none waits on another.

// What the page walk already finds, for ORR-724 to fix: each comes off this list as it's fixed, and until then a new
// case of one of these isn't caught. Any other rule fails the walk.
export const A11Y_KNOWN = ['nested-interactive']

/** The settings as this page reads them, with `changes` over what the server says: the setting is shared, and other
 * specs change it while these walk. */
export async function withSettings(page: Page, changes: () => Record<string, unknown>) {
    await page.route(/\/api\/settings$/, async route => {
        const response = await route.fetch()
        if (route.request().method() !== 'GET') return route.fulfill({response})
        await route.fulfill({response, json: {...await response.json(), ...changes()}})
    })
}

/** Every page in `colorScheme`, against WCAG A and AA (ORR-735). A tint takes contrast away on a light page, so the light
 * pass has the harshest named one. In dark it lightens the faint grey, so the dark pass has none (ORR-855). On this page
 * only, as the setting is shared: chat.spec.ts changes it. */
export async function wcagWalk(page: Page, w: Walked, colorScheme: 'light' | 'dark') {
    test.setTimeout(240_000)
    await withSettings(page, () => ({advanced: true, tint: colorScheme === 'light' ? 'violet' : null}))
    await page.emulateMedia({colorScheme})
    for (const route of ROUTES(w)) {
        await test.step(`${route.path}, ${colorScheme}`, async () => {
            await page.goto(route.path)
            await expect(heading(page, route.heading)).toBeVisible()
            // A fade still running reads as low contrast, and differently each time.
            await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
            const {violations} = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).disableRules(A11Y_KNOWN).analyze()
            expect.soft(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${route.path}, ${colorScheme}`).toEqual([])
        })
    }
}
