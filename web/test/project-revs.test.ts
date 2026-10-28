import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ProjectPatch} from '#shared/patch'
import {applyPatch} from '#shared/patch'
import type {Project} from '#shared/roadmap'
import type {Db} from '../server/utils/database'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A page reads a project whole, labelled with the revision the patches after it build on, and drops a patch it's
// already past (ORR-482): a read that a push overtook has to keep the revision from before it, or the page never
// takes the patch it lacks.
let events: typeof import('../server/utils/events')
let db: Db
let patches: ProjectPatch[]

beforeEach(async () => {
    db = testDb()
    const store = new Store(db)
    await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
    await store.createIssue('greenhouse', {title: 'Hinges'})
    vi.stubGlobal('useDatabase', () => db)
    vi.stubGlobal('hearing', () => false)
    vi.resetModules()
    events = await import('../server/utils/events')
    patches = []
    events.projectEvents.on('patch', patch => patches.push(patch))
})

afterEach(async () => {
    // What a write set off runs on the next turn (the event log among it), with the stubs still in place.
    await new Promise(resolve => setImmediate(resolve))
    vi.unstubAllGlobals()
})

/** As the page gets it: through JSON, which drops what's undefined. */
const sent = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const title = (project: Project) => project.board.chunks.flatMap(chunk => chunk.tasks).find(issue => issue.id === 'GRE-1')?.title

/** What the page does with a patch to the project it read: drop it when it's already past it, else apply it. */
function onPage(read: Project & {rev: number}, patch: ProjectPatch) {
    if (patch.rev <= read.rev) return read
    expect(patch.base).toBeLessThanOrEqual(read.rev)
    return applyPatch(sent(read), sent(patch))
}

/** Changes the issue through the store the pushes come from, and waits for its push. */
async function rename(to: string) {
    const count = patches.length
    await events.useStore().updateIssue('greenhouse', 'GRE-1', {title: to})
    await vi.waitFor(() => expect(patches.length).toBeGreaterThan(count))
    return patches.at(-1)!
}

describe('a project read whole', () => {
    it('keeps the revision from before its read, so a push that overtook it still patches it', async () => {
        await rename('Brass hinges')
        const label = events.revLabel()
        const stale = await events.useStore().project('greenhouse')
        const patch = await rename('Iron hinges')
        const read = label(stale)
        expect(read.rev).toBe(patch.base)
        expect(title(onPage(read, patch)!)).toBe('Iron hinges')
    })

    it('read first while a change is being pushed, takes that push whole, whichever read is labelled first', async () => {
        const store = events.useStore()
        const read = store.project.bind(store)
        const before = events.revLabel()
        const stale = await read('greenhouse')
        // The push's read is held until both pages have theirs: one from before the change, one from after.
        let release!: () => void
        const held = new Promise<void>(resolve => release = resolve)
        vi.spyOn(store, 'project').mockImplementationOnce(async id => {
            await held
            return read(id)
        })
        await store.updateIssue('greenhouse', 'GRE-1', {title: 'Brass hinges'})
        const fresh = events.revLabel()(await read('greenhouse'))
        const old = before(stale)
        release()
        await vi.waitFor(() => expect(patches).toHaveLength(1))
        expect([old.rev, fresh.rev, patches[0]!.base]).toEqual([0, 0, 0])
        expect(title(onPage(old, patches[0]!)!)).toBe('Brass hinges')
        expect(title(onPage(fresh, patches[0]!)!)).toBe('Brass hinges')
    })

    it('read first with nothing being pushed, is what the first patch is made from', async () => {
        const read = events.revLabel()(await events.useStore().project('greenhouse'))
        const patch = await rename('Brass hinges')
        expect(read.rev).toBe(0)
        expect(Object.keys(patch.issues)).toEqual(['GRE-1'])
        expect(title(onPage(read, patch)!)).toBe('Brass hinges')
    })
})
