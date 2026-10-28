import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// The Events page links the issue an event's line names, and its project, from the line itself (ORR-403). The
// changes to the roadmap are kept only while Advanced is on, so it's on for this and off again after.
const api = projectApi('shed')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Shed', key: 'SHD'})
})

test("an issue event's line links the issue, and following it opens the issue", async ({page, request}) => {
    await request.patch('/api/settings', {data: {advanced: true}, headers: OWNER})
    try {
        const issue = await api(request, 'post', '/issues', {title: 'Oil the hinges'})
        await page.goto('/events?project=shed')
        // The line, not its Copy button, which names it too once it's open.
        const line = page.locator('[role=button][aria-expanded]').filter({hasText: new RegExp(`issue\\.created.*made ${issue.id}`)})
        await expect(line).toBeVisible()
        await expect(line.getByRole('link', {name: '[shed]'})).toHaveAttribute('href', '/p/shed')
        const link = line.getByRole('link', {name: issue.id})
        await expect(link).toHaveAttribute('href', `/p/shed/issues/${issue.id}`)

        // The line still opens its details by keyboard; the link opens the issue, not them.
        await line.focus()
        await page.keyboard.press('Enter')
        await expect(line).toHaveAttribute('aria-expanded', 'true')
        await link.click()
        await expect(page).toHaveURL(new RegExp(`/p/shed/issues/${issue.id}$`))
        await expect(page.getByText('Oil the hinges').first()).toBeVisible()
    } finally {
        await request.patch('/api/settings', {data: {advanced: false}, headers: OWNER})
    }
})
