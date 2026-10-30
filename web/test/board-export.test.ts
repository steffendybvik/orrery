import {describe, expect, it} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {EXPORTED, NOT_EXPORTED, USED_ONLY, exportBoard} from '../server/utils/board-export'
import {COPIED_TABLES} from '../server/utils/copy'
import {MIGRATIONS} from '../server/utils/migrations/sqlite'
import {Store} from '../server/utils/store'
import {Secrets} from '../server/utils/secrets'
import {testDb} from './db'

// One board as one file (ORR-668). The round trip back in is on its upload's issue (ORR-670).
const owner = {name: 'skoll', owner: true}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function fullBoard() {
    const db = testDb()
    const store: StoreType = new Store(db, () => {})
    await store.nameOwner({name: 'Skoll'})
    await store.addPerson({name: 'Hati'})
    await store.addPerson({name: 'Fenrir'})
    await store.createProject({name: 'greenhouse', key: 'GRE'}, owner)
    await store.createProject({name: 'cellar', key: 'CEL'}, owner)
    await store.addMember('greenhouse', {person: 'hati'}, owner)
    await store.updateProject('greenhouse', {release_mode: 'own'}, owner)
    const image = await store.createUpload({data: PNG, name: 'tray.png'}, owner)
    const other = await store.createUpload({data: PNG, name: 'cellar.png'}, owner)
    await store.createChunk('greenhouse', {title: 'Joints'}, owner)
    await store.createRelease('greenhouse', {version: '1.0.0'}, owner)
    const parent = await store.createIssue('greenhouse', {title: 'Seed trays', notes: `Look: ${image.markdown}`, assignee: 'hati', status: 'in-progress'}, owner)
    await store.createIssue('greenhouse', {title: 'Sub', parent: parent.id}, owner)
    const elsewhere = await store.createIssue('cellar', {title: 'Racks', notes: other.markdown}, owner)
    await store.updateIssue('greenhouse', parent.id, {depends_on: [`cellar/${elsewhere.id}`]}, owner)
    await store.createComment('greenhouse', parent.id, {body: 'A comment'}, owner)
    await store.createDocSection('greenhouse', {name: 'Decisions'})
    await store.createDoc('greenhouse', {title: 'Notes', body: 'First', section: 'Decisions'}, owner)
    await store.updateDoc('greenhouse', 'notes', {body: 'Second'}, owner)
    await store.createDoc('greenhouse', {title: 'Gone', body: 'Old'}, owner)
    await store.deleteDoc('greenhouse', 'gone', owner)
    await store.createPreset('greenhouse', {name: 'Review', text: 'Look it over'}, owner)
    await new Secrets(store, () => 'a long random test key').set('API_TOKEN', {value: 'hunter2-secret-value', hosts: ['example.com']}, owner)
    const now = new Date().toISOString()
    await db.run("INSERT INTO schedules (project, title, kind, cron, timezone, enabled, created_by, owned, created_at, updated_at) VALUES ('greenhouse', 'Weekly', 'issue', '0 9 * * 1', 'UTC', 1, 'skoll', 1, ?, ?)", now, now)
    return {db, store, parent: parent.id, image: image.id, other: other.id}
}

describe('a board\'s export', () => {
    it('classes every table a copy takes, so a new one has to say', () => {
        const classed = [...Object.keys(EXPORTED), ...Object.keys(NOT_EXPORTED), ...USED_ONLY]
        expect(classed.toSorted()).toEqual([...COPIED_TABLES].toSorted())
        expect(new Set(classed).size).toBe(classed.length)
    })

    it('holds every kind of thing on the board, and only this board\'s', async () => {
        const {db, parent, image, other} = await fullBoard()
        const board = await exportBoard(db, 'greenhouse')
        expect(board).toMatchObject({format: 'orrery-board', format_version: 1, schema_step: MIGRATIONS.length, project: 'greenhouse'})
        const {tables} = board
        expect(tables.projects).toMatchObject([{id: 'greenhouse'}])
        expect(tables.issues.map(i => i.title).sort()).toEqual(['Seed trays', 'Sub'])
        expect(tables.comments).toMatchObject([{body: 'A comment', issue: parent}])
        expect(tables.issue_events.length).toBeGreaterThan(0)
        expect(tables.chunks).toMatchObject([{title: 'Joints'}])
        expect(tables.releases).toMatchObject([{version: '1.0.0'}])
        expect(tables.docs.map(d => d.id)).toEqual(['notes'])
        expect(tables.doc_sections).toMatchObject([{name: 'Decisions'}])
        expect(tables.schedules).toMatchObject([{title: 'Weekly'}])
        expect(tables.presets).toMatchObject([{name: 'Review'}])
        for (const rows of Object.values(tables)) expect(rows.every(row => row.project === undefined || row.project === 'greenhouse')).toBe(true)
        expect(board.uploads.map(u => u.id)).toEqual([image])
        expect(JSON.stringify(board)).not.toContain(other)
        expect(Buffer.from(String(board.uploads[0]?.data), 'base64').length).toBeGreaterThan(0)
    })

    it('keeps a deleted doc\'s history, so it can still come back', async () => {
        const {db} = await fullBoard()
        const {doc_revisions: revisions} = (await exportBoard(db, 'greenhouse')).tables
        expect(revisions.some(r => r.doc === 'gone' && r.deleted)).toBe(true)
        expect(revisions.filter(r => r.doc === 'notes').map(r => r.body)).toContain('First')
    })

    it('keeps old ids', async () => {
        const {db, store} = await fullBoard()
        const {id} = await store.createIssue('greenhouse', {title: 'Moves'}, owner)
        const moved = await store.updateIssue('greenhouse', id, {project: 'cellar'}, owner)
        expect((await exportBoard(db, 'cellar')).tables.issue_aliases).toMatchObject([{alias: id, issue: moved.id}])
    })

    it('holds a link outside the board as the plain reference it is', async () => {
        const {db} = await fullBoard()
        const {issue_links: links} = (await exportBoard(db, 'greenhouse')).tables
        expect(links).toMatchObject([{project: 'greenhouse', on_project: 'cellar'}])
    })

    it('names only the people the board does, as names to match', async () => {
        const {db} = await fullBoard()
        expect((await exportBoard(db, 'greenhouse')).people).toEqual([{id: 'hati', name: 'Hati'}, {id: 'skoll', name: 'Skoll'}])
    })

    it('holds the statuses its issues are in', async () => {
        const {db} = await fullBoard()
        expect((await exportBoard(db, 'greenhouse')).statuses.map(s => s.id)).toContain('in-progress')
    })

    it('holds no secret, credential or live state', async () => {
        const {db, store, parent} = await fullBoard()
        await store.focus('greenhouse', parent, {note: 'signal-words'}, owner)
        await db.run("INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES ('k1', 'skoll', 'agent', 'laptop', 'a-key-hash', '2026-10-30')")
        const text = JSON.stringify(await exportBoard(db, 'greenhouse'))
        for (const word of ['hunter2-secret-value', 'API_TOKEN', 'a-key-hash', 'signal-words']) expect(text).not.toContain(word)
        for (const table of Object.keys(NOT_EXPORTED)) expect(JSON.parse(text).tables[table]).toBeUndefined()
    })

    it('leaves the board as it was', async () => {
        const {db, store} = await fullBoard()
        const before = JSON.stringify(await store.listIssues('greenhouse'))
        await exportBoard(db, 'greenhouse')
        expect(JSON.stringify(await store.listIssues('greenhouse'))).toBe(before)
    })
})
