import {expect, test} from '@playwright/test'

// App settings says where this Orrery keeps its data (ORR-284): the SQLite file, or the Postgres database the
// run is on (E2E_POSTGRES_URL), never with its password.
test('App settings shows where the data is, without a password', async ({page, request}) => {
    if (!(await (await request.get('/api/owner')).json()).named) await request.put('/api/owner', {data: {name: 'Ada Lovelace'}})
    const {database} = await (await request.get('/api/settings')).json()
    const postgres = process.env.E2E_POSTGRES_URL
    if (postgres) {
        const url = new URL(postgres)
        expect(database).toMatchObject({kind: 'postgres', where: `${url.username}@${url.host}${url.pathname}`})
        expect(JSON.stringify(database)).not.toContain(url.password)
    } else {
        expect(database.kind).toBe('sqlite')
        expect(database.where).toMatch(/\/\.data\/e2e\.db$/)
    }

    await page.goto('/settings#database')
    const section = page.locator('#database')
    await expect(section.getByRole('heading', {name: 'Database'})).toBeVisible()
    await expect(section).toContainText(database.where)
    if (postgres) await expect(section).not.toContainText(new URL(postgres).password)
})
