import {EventEmitter} from 'node:events'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {apiTestDb, withApi} from './api'

// Which sessions are there to hear, told to the real Rust API (ORR-1172): as a session's channel connects and goes, and
// on the beat. The rails' claim check on it is cargo's (routes/session_presence_tests.rs).

let store: Store
let sessions: typeof import('../server/utils/sessions')
let presence: typeof import('../server/utils/presence')

beforeEach(async () => {
    vi.stubGlobal('projectEvents', new EventEmitter())
    vi.stubGlobal('launchTarget', (launch: string) => `launch-${launch}`)
    store = new Store(apiTestDb())
    await withApi(store)
    vi.resetModules()
    sessions = await import('../server/utils/sessions')
    presence = await import('../server/utils/presence')
})

const rows = async () => await store.db.all<{session: string, project: string, seen_at: string}>('SELECT session, project, seen_at FROM session_presence ORDER BY session, project')

describe("telling the API who's there", () => {
    it('says a session as its channels connect and go, by the projects it is heard on', async () => {
        const hub = sessions.attend('hub', 'sess-1', undefined, undefined)
        await presence.sayPresence()
        expect((await rows()).map(r => `${r.session} ${r.project}`)).toEqual(['sess-1 hub'])
        // A second project's channel, heard, and one not heard (a skipped channel), which doesn't count.
        const pantry = sessions.attend('pantry', 'sess-1', undefined, undefined)
        sessions.attend('cellar', 'sess-1', undefined, undefined, false)
        await presence.sayPresence()
        expect((await rows()).map(r => `${r.session} ${r.project}`)).toEqual(['sess-1 hub', 'sess-1 pantry'])
        pantry.done()
        await presence.sayPresence()
        expect((await rows()).map(r => r.project)).toEqual(['hub'])
        hub.done()
        await presence.sayPresence()
        expect(await rows()).toEqual([])
    }, 30_000)

    it('says every session again on the beat, so none lapses while it is there', async () => {
        sessions.attend('hub', 'sess-1', undefined, undefined)
        await presence.sayPresence()
        await store.db.run("UPDATE session_presence SET seen_at = '2026-01-01T00:00:00.000Z'")
        // Nothing changed, so a change alone says nothing; the beat says it again.
        await presence.sayPresence()
        expect((await rows())[0]?.seen_at).toBe('2026-01-01T00:00:00.000Z')
        await presence.sayPresence({all: true})
        expect((await rows())[0]?.seen_at > '2026-11-01').toBe(true)
    }, 30_000)
})
