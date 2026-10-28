import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// An agent's question waits in the bell until the owner answers it.
test.describe.configure({mode: 'serial'})

const api = projectApi('porch')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Porch', key: 'POR'})
})

test("an agent's question waits in the bell until the owner answers it", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Pick a hinge', status: 'todo'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak or pine for the hinges?', asks: 'decision'})
    await page.goto('/mine')
    const bell = page.getByRole('link', {name: /waiting on you/})
    await expect(bell).toBeVisible()
    await bell.click()
    await expect(page).toHaveURL(/\/notifications/)
    await expect(page.getByRole('button', {name: `${issue.id}: Pick a hinge`}).or(page.getByRole('link', {name: `${issue.id}: Pick a hinge`})).first()).toBeVisible()

    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak.'}, OWNER)
    await page.goto('/mine')
    await expect(page.getByRole('link', {name: /waiting on you/})).toBeHidden()
})
