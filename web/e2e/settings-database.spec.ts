import {expect, test} from '@playwright/test'

// App settings says where this Orrery keeps its data (ORR-284), and how big it is (ORR-323): the SQLite file, or the Postgres database the
// run is on (E2E_POSTGRES_URL), never with its password. CI's password is `orrery`, also in the user and database
// names, so the checks look for it as `:password@`, the way a URL would carry it.
test('App settings shows where the data is, without a password', async ({page, request}) => {
    if (!(await (await request.get('/api/owner')).json()).named) await request.put('/api/owner', {data: {name: 'Ada Lovelace'}})
    const {database} = await (await request.get('/api/settings')).json()
    const postgres = process.env.E2E_POSTGRES_URL
    expect(database.size).toBeGreaterThan(0)
    if (postgres) {
        const url = new URL(postgres)
        expect(database).toMatchObject({kind: 'postgres', where: `${url.username}@${url.host}${url.pathname}`})
        expect(JSON.stringify(database)).not.toContain(`:${url.password}@`)
    } else {
        expect(database.kind).toBe('sqlite')
        expect(database.where).toMatch(/\/\.data\/e2e\.db$/)
    }

    await page.goto('/settings#database')
    const section = page.locator('#database')
    await expect(section.getByRole('heading', {name: 'Database'})).toBeVisible()
    await expect(section).toContainText(database.where)
    await expect(section.getByText('Size')).toBeVisible()
    if (postgres) await expect(section).not.toContainText(`:${new URL(postgres).password}@`)
})
