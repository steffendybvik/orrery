// The outbox's rows for what reaches sessions and the owner (ORR-929): each signal, each agent's comment for the bell,
// and where an event's value went, so the local app can act on them from the feed as it does from the hooks today.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor, Store} from '../server/utils/store'
import {storeSetup} from './store-setup'

const OWNER: Actor = {name: 'owner', owner: true}
const SESSION: Actor = {name: 'claude', owner: false, session: 'orrery · Vale'}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

let store: Store
let from: number

type Row = {kind: string, project: string | null, subject: string | null, payload: string | null}

/** The rows since the test began, once `until` holds and they've stopped coming, or what's there after 5 s. A write
 * outside a transaction puts its row in the outbox without waiting for it (`runAlone`), so on a busy Postgres it can
 * land well after the write returns: holding still alone isn't enough (ORR-976, ORR-1007). */
async function rows(until: (rows: Row[]) => boolean) {
    const read = () => store.db.all<Row>('SELECT kind, project, subject, payload FROM changes WHERE id > ? ORDER BY id', from)
    const deadline = Date.now() + 5000
    let seen = JSON.stringify(await read())
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 40))
        const now = await read()
        if (JSON.stringify(now) === seen && until(now) || Date.now() > deadline) return now
        seen = JSON.stringify(now)
    }
}

beforeEach(async () => {
    ;({store} = await storeSetup())
    await tick()
    from = Number((await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0)
})

describe('the outbox, for sessions and the bell', () => {
    it('keeps a signal by its id', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Paint it'}, OWNER)
        const signal = await store.focus('greenhouse', id, {}, OWNER)
        const row = {kind: 'signal', project: 'greenhouse', subject: String(signal.id), payload: null}
        expect(await rows(all => all.some(r => r.kind === 'signal'))).toContainEqual(row)
    })

    it("keeps an agent's comment for the bell, with its issue, and not the owner's own", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Paint it'}, OWNER)
        const comment = await store.createComment('greenhouse', id, {body: 'Which colour?'}, SESSION)
        await store.createComment('greenhouse', id, {body: 'Teal.'}, OWNER)
        const notices = (await rows(all => all.some(r => r.kind === 'notice'))).filter(r => r.kind === 'notice')
        expect(notices).toEqual([{kind: 'notice', project: 'greenhouse', subject: String(comment.id), payload: JSON.stringify({issue: id})}])
    })

    it('keeps where a value went, for what a schedule matches on', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Oil it'}, OWNER)
        await store.updateIssue('greenhouse', id, {status: 'done'}, SESSION)
        const status = (await rows(all => all.some(r => r.kind === 'issue.status'))).find(r => r.kind === 'issue.status')
        expect(JSON.parse(status!.payload!)).toMatchObject({to: 'done'})
    })

    it('keeps nothing extra for an event with no value', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Sand it'}, SESSION)
        const created = (all: Row[]) => all.find(r => r.kind === 'issue.created' && r.subject === id)
        expect(created(await rows(all => !!created(all)))?.payload).toBeNull()
    })
})
