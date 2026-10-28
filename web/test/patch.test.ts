import {beforeEach, describe, expect, it} from 'vitest'
import type {Project} from '#shared/roadmap'
import {applyPatch, diffProject, withoutClosed, withoutNotes} from '#shared/patch'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A change sent to the page as what changed, not the whole project (ORR-440): the page builds the project again from
// the patch and what it had, and gets just what a fresh read would give.
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
    await store.createChunk('greenhouse', {title: 'Frames'})
    await store.createChunk('greenhouse', {title: 'Glass'})
    const parent = await store.createIssue('greenhouse', {title: 'Doors', chunk: '1'})
    await store.createIssue('greenhouse', {title: 'Hinges', parent: parent.id})
    await store.createIssue('greenhouse', {title: 'Panes', chunk: '2'})
    await store.createIssue('greenhouse', {title: 'Loose one'})
})

/** As the page gets it: through JSON, which drops what's undefined. */
const sent = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The patch from `before` to the project as it is now, sent and applied to `before` as the page had it, against a
 * fresh read as it would have come. */
async function roundTrip(before: Project) {
    const after = await store.project('greenhouse')
    const patch = diffProject(before, after, 1, 2)
    expect(sent(applyPatch(sent(before), sent(patch)))).toEqual(sent(after))
    return patch
}

describe('patches', () => {
    it('send a changed issue alone, and its chunk as ids, leaving the other chunks out', async () => {
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-2', {title: 'Brass hinges'})
        const patch = await roundTrip(before)
        expect(Object.keys(patch.issues)).toEqual(['GRE-2'])
        expect(patch.board.chunks.filter(c => 'same' in c).map(c => c.id)).toEqual(['2', ''].filter(id => before.board.chunks.some(c => c.id === id)))
    })

    it('move, nest, add and remove issues, and change chunks and the project', async () => {
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-3', {parent: 'GRE-1'})
        await store.createIssue('greenhouse', {title: 'Vents', chunk: '2'})
        await store.deleteIssue('greenhouse', 'GRE-4')
        await store.updateChunk('greenhouse', '1', {title: 'Timber frames'})
        await store.updateProject('greenhouse', {description: 'A glasshouse', icon: 'home'})
        const patch = await roundTrip(before)
        expect(patch.fields).toMatchObject({description: 'A glasshouse', icon: 'home'})
        const between = await store.project('greenhouse')
        await store.updateProject('greenhouse', {icon: null})
        expect((await roundTrip(between)).unset).toEqual(['icon'])
    })

    it('send nothing of an issue or chunk that did not change', async () => {
        const before = await store.project('greenhouse')
        const patch = await roundTrip(before)
        expect(patch.issues).toEqual({})
        expect(patch.board.chunks.every(c => 'same' in c)).toBe(true)
    })

    it('make a whole project from nothing, and say when one cannot be applied', async () => {
        const after = await store.project('greenhouse')
        const whole = diffProject(undefined, after, 0, 1)
        expect(sent(applyPatch({board: {chunks: []}} as unknown as Project, sent(whole)))).toEqual(sent(after))
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-1', {title: 'Double doors'})
        const patch = diffProject(before, await store.project('greenhouse'), 1, 2)
        expect(applyPatch({...before, board: {...before.board, chunks: []}}, patch)).toBeNull()
    })

    it('leave the notes of every issue out, at any depth, and nothing else', async () => {
        await store.updateIssue('greenhouse', 'GRE-1', {notes: 'Oak, not pine'})
        await store.updateIssue('greenhouse', 'GRE-2', {notes: 'Brass'})
        const project = await store.project('greenhouse')
        const light = withoutNotes(project)
        expect(JSON.stringify(light)).not.toMatch(/Oak, not pine|Brass/)
        const doors = light.board.chunks.flatMap(c => c.tasks).find(i => i.id === 'GRE-1')
        expect(doors).toMatchObject({title: 'Doors', tasks: [{id: 'GRE-2', title: 'Hinges'}]})
        expect(doors && 'notes' in doors).toBe(false)
        expect(JSON.stringify(project)).toMatch(/Oak, not pine/)
    })
})

describe('a project read without its closed issues (ORR-447)', () => {
    const ids = (project: Project) => {
        const found: string[] = []
        const walk = (issues: Project['board']['chunks'][number]['tasks']) => issues.forEach(i => {
            found.push(i.id)
            walk(i.tasks)
        })
        project.board.chunks.forEach(c => walk(c.tasks))
        return found.sort()
    }
    /** The patch to the project as it is now, applied to what a partial read gave, against a fresh partial read. */
    async function partialTrip(before: Project) {
        const after = await store.project('greenhouse')
        const patched = applyPatch(sent(withoutClosed(before)), sent(diffProject(before, after, 1, 2)), true)
        expect(patched && ids(patched)).toEqual(ids(withoutClosed(after)))
        return patched!
    }

    it('leaves out closed issues, but keeps one with open work under it', async () => {
        await store.updateIssue('greenhouse', 'GRE-3', {status: 'done'})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'})
        const project = await store.project('greenhouse')
        expect(ids(withoutClosed(project))).toEqual(['GRE-1', 'GRE-2', 'GRE-4'])
        await store.updateIssue('greenhouse', 'GRE-2', {status: 'canceled'})
        expect(ids(withoutClosed(await store.project('greenhouse')))).toEqual(['GRE-4'])
    })

    it('takes patches, leaving out the closed issues it never had, changed or not', async () => {
        await store.updateIssue('greenhouse', 'GRE-3', {status: 'done'})
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-3', {title: 'Panes, fitted'})
        await store.updateIssue('greenhouse', 'GRE-4', {title: 'Still loose'})
        const patched = await partialTrip(before)
        expect(patched.board.chunks.flatMap(c => c.tasks).find(i => i.id === 'GRE-4')?.title).toBe('Still loose')
    })

    it('keeps one it had that closes, and takes one that opens again', async () => {
        await store.updateIssue('greenhouse', 'GRE-3', {status: 'done'})
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-4', {status: 'done'})
        await store.updateIssue('greenhouse', 'GRE-3', {status: 'todo'})
        const after = await store.project('greenhouse')
        const patched = applyPatch(sent(withoutClosed(before)), sent(diffProject(before, after, 1, 2)), true)!
        expect(ids(patched)).toEqual(['GRE-1', 'GRE-2', 'GRE-3', 'GRE-4'])
    })

    it('takes a closed issue it never had back when work under it opens again', async () => {
        await store.updateIssue('greenhouse', 'GRE-2', {status: 'done'})
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'})
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-2', {status: 'todo'})
        expect(ids(await partialTrip(before))).toEqual(['GRE-1', 'GRE-2', 'GRE-3', 'GRE-4'])
    })

    it("can't be applied when open work turns up under a closed issue it never had, and isn't sent", () => {
        const issue = (id: string, kind: string) => ({id, title: id, kind, tasks: []})
        const project = {id: 'greenhouse', board: {chunks: [{id: '1', title: 'Frames', tasks: []}], counts: {}, kinds: {}}} as unknown as Project
        const patch = {id: 'greenhouse', base: 1, rev: 2, fields: {}, unset: [], board: {counts: {}, kinds: {}, chunks: [{id: '1', title: 'Frames', tasks: [{id: 'GRE-1', tasks: [{id: 'GRE-2', tasks: []}]}]}]},
            issues: {'GRE-2': issue('GRE-2', 'todo')}} as unknown as Parameters<typeof applyPatch>[1]
        expect(applyPatch(project, patch, true)).toBeNull()
        // A closed one alone it never had stays out.
        expect(applyPatch(project, {...patch, issues: {'GRE-2': issue('GRE-2', 'done')}} as typeof patch, true)!.board.chunks[0]!.tasks).toEqual([])
    })
})
