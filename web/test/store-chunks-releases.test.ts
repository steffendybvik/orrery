// Chunks and releases: made, ordered, frozen, shipped and shared between projects. The store, against a fresh database
// with the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import type {Actor} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
let changes: string[]

beforeEach(async () => {
    ({store, changes} = await storeSetup())
})

describe('chunks', () => {
    it('have a priority to set and clear', async () => {
        expect((await store.chunk('greenhouse', '1')).priority).toBeUndefined()
        expect((await store.updateChunk('greenhouse', '1', {priority: 'P1'})).priority).toBe('P1')
        expect((await store.project('greenhouse')).board.chunks[0]!.priority).toBe('P1')
        expect((await store.updateChunk('greenhouse', '1', {priority: null})).priority).toBeUndefined()
        expect((await failure(() => store.updateChunk('greenhouse', '1', {priority: 'P7'}))).status).toBe(400)
    })

    it('can be focused on, by their id or a name they had', async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.kind}:${signal.issue ?? '-'}:${signal.chunk}:${signal.target ?? 'all'}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        await local.createChunk('greenhouse', {title: 'Joints'})
        const signal = await local.focusChunk('greenhouse', '1', {session: 'joints-window', note: 'urgent'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: '1', kind: 'focus', note: 'urgent', protected: true})
        expect(signal.issue).toBeUndefined()
        expect(sent).toEqual(['focus:-:1:joints-window'])
        expect((await local.listSignals('greenhouse', 0, 50, {chunk: '1'})).map(s => s.id)).toEqual([signal.id])
        expect(await local.lastSignal('greenhouse')).toBe(signal.id)
        expect((await failure(() => local.focusChunk('greenhouse', '9', {}))).status).toBe(404)
        expect((await local.focusChunk('greenhouse', 'none', {})).chunk).toBe('none')
    })

    it('can be focused on for their issues of one status', async () => {
        const local = new Store(testDb(), () => {})
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        await local.createChunk('greenhouse', {title: 'Joints'})
        expect((await local.focusChunk('greenhouse', '1', {status: 'todo'}, {name: 'skoll', owner: true})).status).toBe('todo')
        expect((await local.focusChunk('greenhouse', '1', {})).status).toBeUndefined()
        expect((await failure(() => local.focusChunk('greenhouse', '1', {status: 'done'}))).status).toBe(400)
        expect((await failure(() => local.focusChunk('greenhouse', '1', {status: 'soon'}))).status).toBe(400)
        // An old word is kept as the kind it means now, so the scope finds its issues.
        expect((await local.focusChunk('greenhouse', '1', {status: 'doing, todo'})).status).toBe('started,todo')
    })

    it('can be focused on all at once, for issues of several statuses and a release', async () => {
        const local = new Store(testDb(), () => {})
        await local.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
        await local.createRelease('greenhouse', {version: '1.0.0'})
        const signal = await local.focusChunk('greenhouse', 'all', {status: 'todo, started', release: '1.0.0'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: 'all', status: 'todo,started', release: '1.0.0'})
        expect((await failure(() => local.focusChunk('greenhouse', 'all', {status: 'todo,done'}))).message).toContain('"status" has "done"')
        expect((await failure(() => local.focusChunk('greenhouse', 'all', {release: '9.9'}))).status).toBe(404)
        await local.createIssue('greenhouse', {title: 'Hinges', status: 'todo'})
        await local.createIssue('greenhouse', {title: 'Pins', status: 'in-progress'})
        await local.createIssue('greenhouse', {title: 'Bolts'})
        expect((await local.listIssues('greenhouse', {status: 'todo,started'})).map(i => i.title)).toEqual(['Hinges', 'Pins'])
    })
})
describe('releases', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    beforeEach(async () => {
        await store.updateProject('greenhouse', {release_mode: 'own'})
    })

    it("are none of a new project's until it turns them on, and go off only with none left", async () => {
        const made = await store.createProject({name: 'garden', key: 'GAR'})
        expect([made.release_mode, made.releases]).toEqual(['none', []])
        expect(await failure(() => store.createRelease('garden', {version: '1.0.0'})))
            .toEqual({status: 400, message: 'garden has no releases; turn them on with PATCH /api/projects/garden {"release_mode": "own"}'})
        expect((await failure(() => store.createIssue('garden', {title: 'Weed', release: '1.0.0'}))).status).toBe(400)
        expect((await store.updateProject('garden', {release_mode: 'own'})).release_mode).toBe('own')
        await store.createRelease('garden', {version: '1.0.0'})
        expect((await failure(() => store.updateProject('garden', {release_mode: 'none'}))).status).toBe(409)
        await store.deleteRelease('garden', '1.0.0')
        expect((await store.updateProject('garden', {release_mode: 'none'})).releases).toEqual([])
        expect((await failure(() => store.updateProject('garden', {release_mode: 'paused'}))).status).toBe(400)
    })

    it('are arranged by hand, a new one on top, and only where they are made', async () => {
        for (const version of ['1.0.0', '1.1.0', '1.2.0']) await store.createRelease('greenhouse', {version})
        const versions = async () => (await store.project('greenhouse')).releases.map(r => r.version)
        expect(await versions()).toEqual(['1.2.0', '1.1.0', '1.0.0'])
        await store.updateRelease('greenhouse', '1.0.0', {position: 0})
        expect(await versions()).toEqual(['1.0.0', '1.2.0', '1.1.0'])
        await store.updateRelease('greenhouse', '1.0.0', {position: 99})
        expect(await versions()).toEqual(['1.2.0', '1.1.0', '1.0.0'])
        await store.createRelease('greenhouse', {version: '1.3.0', position: 1})
        expect(await versions()).toEqual(['1.2.0', '1.3.0', '1.1.0', '1.0.0'])
        // Shipping it leaves it where it is.
        await store.updateRelease('greenhouse', '1.3.0', {shipped_on: '2026-10-26'})
        expect(await versions()).toEqual(['1.2.0', '1.3.0', '1.1.0', '1.0.0'])
        await store.createProject({name: 'hub', key: 'HUB', releases_from: 'greenhouse'})
        expect((await store.project('hub')).releases.map(r => r.version)).toEqual(await versions())
        expect((await failure(() => store.updateRelease('hub', '1.0.0', {position: 0}))).status).toBe(400)
    })

    it('are made by version and refuse a second of the same', async () => {
        const made = await store.createRelease('greenhouse', {version: '1.0.0-rc.2', branch: ' v1.0.0-rc.2 '})
        expect(made).toMatchObject({version: '1.0.0-rc.2', branch: 'v1.0.0-rc.2', issues: 0, tasks: [], project: 'greenhouse'})
        expect((await failure(() => store.createRelease('greenhouse', {version: '1.0.0-rc.2'}))).status).toBe(409)
        expect((await failure(() => store.createRelease('greenhouse', {version: 'one two'}))).status).toBe(400)
        expect((await failure(() => store.createRelease('greenhouse', {version: '1.0.0', shipped_on: 'today'}))).status).toBe(400)
    })

    it('are checked as they would be made or changed, saving nothing (the chat asks first)', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0', branch: 'v1.0.0'})
        expect(await store.checkRelease('greenhouse', {version: '1.1.0', branch: 'v1.1.0'})).toBeUndefined()
        expect(await store.checkRelease('greenhouse', {shipped_on: '2026-10-29'}, '1.0.0')).toMatchObject({version: '1.0.0', branch: 'v1.0.0'})
        expect((await store.listReleases('greenhouse')).map(r => r.version)).toEqual(['1.0.0'])
        expect((await failure(() => store.checkRelease('greenhouse', {version: '1.0.0'}))).status).toBe(409)
        expect((await failure(() => store.checkRelease('greenhouse', {version: 'one point one'}))).status).toBe(400)
        expect((await failure(() => store.checkRelease('greenhouse', {shipped_on: 'today'}, '1.0.0'))).status).toBe(400)
        expect((await failure(() => store.checkRelease('greenhouse', {version: '2.0.0'}, '1.0.0'))).status).toBe(400)
        expect((await failure(() => store.checkRelease('greenhouse', {notes: 'X'}, '0.9.0'))).status).toBe(404)
        await store.createProject({name: 'garden', key: 'GAR'})
        expect((await failure(() => store.checkRelease('garden', {version: '1.0.0'}))).status).toBe(400)
    })

    it('count their issues, a parent with its sub-issues; the newest on top', async () => {
        await store.createRelease('greenhouse', {version: '0.8.0', shipped_on: '2026-09-01'})
        await store.createRelease('greenhouse', {version: '0.9.0', shipped_on: '2026-10-01'})
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.createRelease('greenhouse', {version: '1.1.0'})
        const parent = await store.createIssue('greenhouse', {title: 'Hinges', chunk: '1', release: '1.0.0'})
        await store.createIssue('greenhouse', {title: 'Pin', parent: parent.id, status: 'done'})
        await store.createIssue('greenhouse', {title: 'Socket', parent: parent.id, release: '1.0.0'})
        const loose = await store.createIssue('greenhouse', {title: 'Ball joint', chunk: '1'})
        await store.createIssue('greenhouse', {title: 'Its socket', parent: loose.id, release: '1.1.0', status: 'done'})

        const [newer, older, ...shipped] = (await store.project('greenhouse')).releases
        expect(shipped.map(r => r.version)).toEqual(['0.9.0', '0.8.0'])
        expect(newer).toMatchObject({version: '1.1.0', issues: 1, kinds: {done: 1}})
        expect(older).toMatchObject({version: '1.0.0', issues: 1, kinds: {done: 1, backlog: 1}})
        expect((await store.release('greenhouse', '1.0.0')).tasks.map(t => t.id)).toEqual([parent.id])
        expect((await store.listIssues('greenhouse', {release: '1.0.0'})).map(i => i.title)).toEqual(['Hinges', 'Socket'])
        expect((await store.listIssues('greenhouse', {release: 'none'})).map(i => i.title)).toEqual(['Pin', 'Ball joint'])
        expect((await failure(() => store.listIssues('greenhouse', {release: '9.9'}))).status).toBe(404)
    })

    it("count a sub-issue set for another release there, not in its parent's", async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.createRelease('greenhouse', {version: '1.0.0-rc.2'})
        const parent = await store.createIssue('greenhouse', {title: 'Hinges', chunk: '1', release: '1.0.0'})
        await store.createIssue('greenhouse', {title: 'Pin', parent: parent.id})
        const early = await store.createIssue('greenhouse', {title: 'Socket', parent: parent.id, release: '1.0.0-rc.2', status: 'done'})
        await store.createIssue('greenhouse', {title: 'Its screw', parent: early.id, status: 'done'})
        await store.createIssue('greenhouse', {title: 'Its washer', parent: early.id, release: '1.0.0-rc.2'})

        const [rc, final] = (await store.project('greenhouse')).releases
        expect(rc).toMatchObject({version: '1.0.0-rc.2', issues: 1, kinds: {done: 1, backlog: 1}})
        expect(final).toMatchObject({version: '1.0.0', issues: 1, kinds: {done: 0, backlog: 1}})
        expect((await store.release('greenhouse', '1.0.0-rc.2')).tasks.map(t => t.title)).toEqual(['Socket'])
    })

    it('are set on an issue and taken off, as its activity says', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges'})
        expect((await store.updateIssue('greenhouse', issue.id, {release: '1.0.0'})).release).toBe('1.0.0')
        expect((await failure(() => store.updateIssue('greenhouse', issue.id, {release: '2.0.0'}))).status).toBe(404)
        expect((await store.updateIssue('greenhouse', issue.id, {release: null})).release).toBeUndefined()
        expect((await store.listActivity('greenhouse', issue.id)).filter(e => e.field === 'release').map(e => [e.before, e.after]))
            .toEqual([[undefined, '1.0.0'], ['1.0.0', undefined]])
    })

    it('change all but their version, and go leaving their issues in none', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        expect(await store.updateRelease('greenhouse', '1.0.0', {notes: 'Joints.', shipped_on: '2026-10-25', branch: ''})).toMatchObject({notes: 'Joints.', shipped_on: '2026-10-25'})
        expect((await store.release('greenhouse', '1.0.0')).branch).toBeUndefined()
        expect((await failure(() => store.updateRelease('greenhouse', '1.0.0', {version: '1.0.1'}))).status).toBe(400)
        await store.deleteRelease('greenhouse', '1.0.0')
        expect((await store.issue('greenhouse', issue.id)).release).toBeUndefined()
        expect((await store.project('greenhouse')).releases).toEqual([])
    })

    it('freeze and thaw, still taking issues while frozen', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0', frozen_on: '2026-10-20'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        expect((await store.release('greenhouse', '1.0.0')).frozen_on).toBe('2026-10-20')
        expect((await failure(() => store.updateRelease('greenhouse', '1.0.0', {frozen_on: 'now'}))).status).toBe(400)
        expect((await store.updateRelease('greenhouse', '1.0.0', {frozen_on: null})).frozen_on).toBeUndefined()
        expect((await store.issue('greenhouse', issue.id)).release).toBe('1.0.0')
    })

    it("are the owner's to delete when the owner made them", async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'}, owner)
        expect((await failure(() => store.deleteRelease('greenhouse', '1.0.0'))).status).toBe(403)
        await store.deleteRelease('greenhouse', '1.0.0', owner)
    })

    it('stay behind when their issue moves to another project', async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        const moved = await store.updateIssue('greenhouse', issue.id, {project: 'pantry'})
        expect(moved.release).toBeUndefined()
        expect((await store.project('greenhouse')).releases[0]!.issues).toBe(0)
    })

    it('go with their project', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.deleteProject('greenhouse')
        await store.createProject({name: 'greenhouse', key: 'GRE'})
        expect((await store.project('greenhouse')).releases).toEqual([])
    })
    describe('shared across projects', () => {
        beforeEach(async () => {
            await store.createProject({name: 'repository', key: 'REP', release_mode: 'own'})
            await store.createProject({name: 'hub', key: 'HUB', releases_from: 'repository'})
            await store.createProject({name: 'pos', key: 'POS'})
            await store.updateProject('pos', {releases_from: 'repository'})
            await store.createRelease('repository', {version: '2.25.0'})
        })

        it("let a project's issues ship in its source's releases, counted there across projects", async () => {
            const own = await store.createIssue('repository', {title: 'Release PR', release: '2.25.0'})
            const hub = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0', status: 'done'})
            const pos = await store.createIssue('pos', {title: 'Receipts'})
            await store.updateIssue('pos', pos.id, {release: '2.25.0'})
            await store.createIssue('pos', {title: 'Tips', parent: pos.id})

            expect((await store.project('hub'))).toMatchObject({release_mode: 'shared', releases_from: 'repository'})
            expect((await store.project('repository')).releases[0]).toMatchObject({version: '2.25.0', issues: 3, kinds: {done: 1, backlog: 2}})
            // A project drawing on it counts its own part.
            expect((await store.project('pos')).releases[0]).toMatchObject({version: '2.25.0', issues: 1, kinds: {backlog: 1}})
            const release = await store.release('repository', '2.25.0')
            expect(release.tasks.map(t => t.id)).toEqual([own.id])
            expect(release.projects.map(p => [p.project, p.issues, p.tasks.map(t => t.id)])).toEqual([['repository', 1, [own.id]], ['hub', 1, [hub.id]], ['pos', 1, [pos.id]]])
            expect((await store.release('hub', '2.25.0')).projects.map(p => p.project)).toEqual(['hub'])
            expect((await store.listIssues('hub', {release: '2.25.0'})).map(i => i.id)).toEqual([hub.id])
            expect((await failure(() => store.createIssue('hub', {title: 'x', release: '9.9.9'}))).message).toContain('No release 9.9.9 in repository (where hub takes its releases from)')
        })

        it('are made, changed and deleted only in the source, which clears them everywhere', async () => {
            expect(await failure(() => store.createRelease('hub', {version: '2.26.0'})))
                .toEqual({status: 400, message: 'hub takes its releases from repository; make them there: /api/projects/repository/releases'})
            expect((await failure(() => store.updateRelease('hub', '2.25.0', {notes: 'x'}))).status).toBe(400)
            expect((await failure(() => store.deleteRelease('hub', '2.25.0'))).status).toBe(400)
            const hub = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0'})
            await store.deleteRelease('repository', '2.25.0')
            expect((await store.issue('hub', hub.id)).release).toBeUndefined()
        })

        it('go one level deep, and never merge with releases a project already has', async () => {
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'hub'}))).message).toBe('hub takes its releases from repository; take them from repository too')
            expect((await failure(() => store.updateProject('repository', {releases_from: 'greenhouse'}))).message).toBe('hub, pos take their releases from repository, so it keeps its own')
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'greenhouse'}))).status).toBe(400)
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'nowhere'}))).status).toBe(400)
            await store.createProject({name: 'garden', key: 'GAR'})
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'garden'}))).message).toBe('garden has no releases; give it its own first (release_mode "own")')
            expect((await failure(() => store.updateProject('garden', {release_mode: 'shared'}))).status).toBe(400)
            expect((await failure(() => store.updateProject('garden', {release_mode: 'own', releases_from: 'repository'}))).status).toBe(400)
            expect((await store.updateProject('garden', {release_mode: 'shared', releases_from: 'repository'})).release_mode).toBe('shared')
            await store.createRelease('greenhouse', {version: '1.0.0'})
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'repository'}))).status).toBe(409)
        })

        it("keep an issue's release when it moves within them, and when the project gets its own back, it has none", async () => {
            const issue = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0'})
            const moved = await store.updateIssue('hub', issue.id, {project: 'pos'})
            expect(moved.release).toBe('2.25.0')
            expect((await store.updateIssue('pos', moved.id, {project: 'greenhouse'})).release).toBeUndefined()
            const other = await store.createIssue('pos', {title: 'Receipts', release: '2.25.0'})
            await store.updateProject('pos', {releases_from: null})
            expect((await store.issue('pos', other.id)).release).toBeUndefined()
            expect((await store.project('pos'))).toMatchObject({release_mode: 'own', releases: []})
            const third = await store.createIssue('hub', {title: 'Credit notes', release: '2.25.0'})
            await store.updateProject('hub', {release_mode: 'none'})
            expect((await store.issue('hub', third.id)).release).toBeUndefined()
        })

        it('keep their source from being deleted, and tell each other about changes', async () => {
            expect((await failure(() => store.deleteProject('repository'))).status).toBe(409)
            changes.length = 0
            await store.createIssue('hub', {title: 'Invoices'})
            await store.updateRelease('repository', '2.25.0', {notes: 'Together.'})
            await new Promise(resolve => setTimeout(resolve, 10))
            expect(new Set(changes)).toEqual(new Set(['hub', 'repository', 'pos']))
        })
    })
})
