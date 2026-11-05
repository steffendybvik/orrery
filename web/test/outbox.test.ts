// The Nuxt server's own writes put what they set off in the outbox, as the Rust API's do (ORR-929), and what the router
// relays from a write the API made doesn't go in twice.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Store} from '../server/utils/store'
import {storeSetup} from './store-setup'

const OWNER = {name: 'owner', owner: true}
const SESSION = {name: 'claude', owner: false, session: 'orrery · Andvare'}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

let store: Store
let from: number

/** The rows since the test started, the few fields that say what they are. */
async function rows() {
    await tick()
    return (await store.db.all<{kind: string, project: string | null, subject: string | null, actor: string | null, owner: number, session: string | null, cause: string | null}>(
        'SELECT kind, project, subject, actor, owner, session, cause FROM changes WHERE id > ? ORDER BY id', from))
        .map(r => ({...r, owner: Number(r.owner)}))
}

beforeEach(async () => {
    ;({store} = await storeSetup())
    await tick()
    from = Number((await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0)
})

describe('the outbox, from the store', () => {
    it('keeps an issue made: the project once, and what it told, with who did it', async () => {
        const issue = await store.createIssue('greenhouse', {title: 'Water the ferns'}, SESSION)
        const got = await rows()
        expect(got.filter(r => r.kind === 'project.changed')).toEqual([{kind: 'project.changed', project: 'greenhouse', subject: null, actor: null, owner: 0, session: null, cause: null}])
        expect(got).toContainEqual({kind: 'issue.created', project: 'greenhouse', subject: issue.id, actor: 'claude', owner: 0, session: 'orrery · Andvare', cause: null})
    })

    it('keeps a settings change, as its owner made it', async () => {
        await store.updateSettings({advanced: true}, OWNER)
        expect(await rows()).toContainEqual({kind: 'settings', project: null, subject: null, actor: 'owner', owner: 1, session: null, cause: null})
    })

    it('keeps the schedule run that did it', async () => {
        store.cause = () => '7'
        await store.createIssue('greenhouse', {title: 'Made by a schedule'}, SESSION)
        expect((await rows()).every(r => r.cause === '7')).toBe(true)
    })

    it("adds nothing for what the router relays from the Rust API's writes, which wrote their own", async () => {
        await store.relaying(async () => {
            store.changed('greenhouse')
            await store.settingsChanged()
            store.told('doc.created', 'greenhouse', 'notes', SESSION)
        })
        expect(await rows()).toEqual([])
    })
})
