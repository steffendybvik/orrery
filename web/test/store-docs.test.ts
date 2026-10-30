// Docs and images: written, listed, synced from a repo, and uploaded. The store, against a fresh database with the
// project `greenhouse` (store-setup.ts).
import {randomBytes} from 'node:crypto'
import sharp from 'sharp'
import {beforeEach, describe, expect, it} from 'vitest'
import {UPLOAD_LIMIT} from '../server/utils/store'
import type {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
})

describe('docs', () => {
    it('list with a summary of their first paragraph, and search their title and text', async () => {
        await store.createDoc('greenhouse', {title: 'Decision: ids', body: '# Decision: ids\n\n![logo](/api/uploads/x)\n\nIssues get the project\'s **prefix** and a number, [handed out](https://x.y) by `orrery`.\nNever reused.\n\nMore later.'})
        await store.createDoc('greenhouse', {title: 'Running', body: '```sh\npnpm dev\n```\n\n' + 'word '.repeat(60)})
        const docs = await store.listDocs('greenhouse')
        expect(docs.map(d => d.summary)).toEqual([
            "Issues get the project's prefix and a number, handed out by orrery. Never reused.",
            expect.stringMatching(/^(word ){20,}word…$/),
        ])
        expect(docs[1]!.summary.length).toBeLessThanOrEqual(161)
        expect((await store.listDocs('greenhouse', {q: 'REUSED'})).map(d => [d.id, d.match])).toEqual([['decision-ids', expect.stringMatching(/^….*Never reused\..*$/)]])
        expect((await store.listDocs('greenhouse', {q: 'reused number'})).map(d => d.id)).toEqual(['decision-ids'])
        expect((await store.listDocs('greenhouse', {q: 'reused pnpm'})).map(d => d.id)).toEqual([])
        // Title hits first, then A–Z.
        expect((await store.listDocs('greenhouse', {q: 'running'})).map(d => [d.id, d.match])).toEqual([['running', '']])
        await store.createDoc('greenhouse', {title: 'About', body: 'See running.'})
        expect((await store.listDocs('greenhouse', {q: 'running'})).map(d => d.id)).toEqual(['running', 'about'])
        expect(await store.listDocs('greenhouse', {q: 'nothing like it'})).toEqual([])
    })
})
describe('docs', () => {
    it('are listed with the project, without their text', async () => {
        const doc = await store.createDoc('greenhouse', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.'})
        expect(doc).toMatchObject({id: 'how-joints-work', created_by: 'agent', protected: false})
        expect((await store.project('greenhouse')).docs.map(d => d.id)).toEqual(['how-joints-work'])
        expect((await store.project('greenhouse')).docs[0]).not.toHaveProperty('body')
        expect((await store.doc('greenhouse', doc.id)).body).toContain('**hinge**')
    })

    it('are listed by title, A–Z, whatever order they were made in', async () => {
        for (const title of ['Running', 'decision: ids', 'API', 'Decision: owner']) await store.createDoc('greenhouse', {title})
        expect((await store.listDocs('greenhouse')).map(d => d.title)).toEqual(['API', 'decision: ids', 'Decision: owner', 'Running'])
    })

    it('are created or replaced at their id with PUT', async () => {
        expect((await store.putDoc('greenhouse', 'readme', {title: 'Readme', body: 'one'})).created).toBe(true)
        const {doc, created} = await store.putDoc('greenhouse', 'readme', {title: 'README', body: 'two'})
        expect([created, doc.title, doc.body]).toEqual([false, 'README', 'two'])
        expect((await failure(() => store.putDoc('greenhouse', 'Bad Id', {title: 'x'}))).status).toBe(400)
    })

    it('are filed under a section, kept through a PUT that leaves it out, and taken out of it with none (ORR-520)', async () => {
        const made = await store.createDoc('greenhouse', {id: 'decision-ids', title: 'Decision: ids', section: '  Decisions '})
        expect(made.section).toBe('Decisions')
        expect((await store.listDocs('greenhouse'))[0]).toMatchObject({id: 'decision-ids', section: 'Decisions'})
        // A repo's file synced in keeps its place.
        expect((await store.putDoc('greenhouse', 'decision-ids', {title: 'Decision: ids', body: 'Synced.'})).doc.section).toBe('Decisions')
        // Moving it isn't a change to read: it stays as seen.
        const before = (await store.doc('greenhouse', 'decision-ids')).updated_at
        await new Promise(resolve => setTimeout(resolve, 5))
        expect((await store.updateDoc('greenhouse', 'decision-ids', {section: 'How it works'})).updated_at).toBe(before)
        expect((await store.updateDoc('greenhouse', 'decision-ids', {section: ''})).section).toBeUndefined()
        expect((await store.updateDoc('greenhouse', 'decision-ids', {section: 'Decisions'})).section).toBe('Decisions')
        expect((await store.updateDoc('greenhouse', 'decision-ids', {section: null})).section).toBeUndefined()
    })

    it('have sections made empty, renamed on every doc at once and deleted keeping their docs (ORR-560)', async () => {
        await store.createDoc('greenhouse', {id: 'decision-ids', title: 'Decision: ids', section: 'Decisions'})
        await store.createDoc('greenhouse', {id: 'decision-docs', title: 'Decision: docs', section: 'Decisions'})
        expect(await store.createDocSection('greenhouse', {name: ' Research '})).toBe('Research')
        expect(await store.docSections('greenhouse')).toEqual(['Decisions', 'Research'])
        expect((await store.project('greenhouse')).doc_sections).toEqual(['Decisions', 'Research'])
        expect(await failure(() => store.createDocSection('greenhouse', {name: 'Decisions'}))).toMatchObject({status: 409})
        expect(await failure(() => store.createDocSection('greenhouse', {name: '  '}))).toMatchObject({status: 400})

        // Renaming isn't a change to read either.
        const before = (await store.doc('greenhouse', 'decision-ids')).updated_at
        await new Promise(resolve => setTimeout(resolve, 5))
        expect(await store.renameDocSection('greenhouse', 'Decisions', {name: 'Choices'})).toBe('Choices')
        expect((await store.listDocs('greenhouse')).map(d => d.section)).toEqual(['Choices', 'Choices'])
        expect((await store.doc('greenhouse', 'decision-ids')).updated_at).toBe(before)
        expect(await store.renameDocSection('greenhouse', 'Research', {name: 'Findings'})).toBe('Findings')
        expect(await store.docSections('greenhouse')).toEqual(['Choices', 'Findings'])
        expect(await failure(() => store.renameDocSection('greenhouse', 'Choices', {name: 'Findings'}))).toMatchObject({status: 409})
        expect(await failure(() => store.renameDocSection('greenhouse', 'Nowhere', {name: 'Else'}))).toMatchObject({status: 404})

        // An empty one stays until it's deleted; deleting one keeps its docs, under no section.
        await store.deleteDocSection('greenhouse', 'Choices')
        expect((await store.listDocs('greenhouse')).map(d => d.section)).toEqual([undefined, undefined])
        expect(await store.docSections('greenhouse')).toEqual(['Findings'])
        await store.deleteDocSection('greenhouse', 'Findings')
        expect(await store.docSections('greenhouse')).toEqual([])
        expect(await failure(() => store.deleteDocSection('greenhouse', 'Findings'))).toMatchObject({status: 404})
    })

    it('number a long title made twice within the 40 an id may be, so PUT still reaches it', async () => {
        const title = 'How the launcher starts sessions in tmux and hands them over'
        const first = await store.createDoc('greenhouse', {title})
        const second = await store.createDoc('greenhouse', {title})
        expect(first.id).toHaveLength(40)
        expect(second.id).toBe(`${first.id.slice(0, 38).replace(/-+$/, '')}-2`)
        expect(second.id.length).toBeLessThanOrEqual(40)
        expect((await store.putDoc('greenhouse', second.id, {title, body: 'synced'})).created).toBe(false)
    })

    it("are the owner's to delete when the owner wrote them", async () => {
        await store.createDoc('greenhouse', {id: 'mine', title: 'Mine'}, {name: 'skoll', owner: true})
        expect((await failure(() => store.deleteDoc('greenhouse', 'mine'))).status).toBe(403)
        expect((await failure(() => store.deleteProject('greenhouse'))).status).toBe(403)
        await store.deleteDoc('greenhouse', 'mine', {name: 'skoll', owner: true})
        expect(await store.listDocs('greenhouse')).toEqual([])
    })
})
describe('images', () => {
    // A 1×1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    it('keeps one, and hands back where it is and the Markdown that shows it', async () => {
        const image = await store.createUpload({data: `data:image/png;base64,${png}`, name: 'Shelf [left].png'})
        expect(image).toMatchObject({type: 'image/png', size: 70, url: `/api/uploads/${image.id}`, markdown: `![Shelf left](/api/uploads/${image.id})`})
        const kept = await store.upload(image.id)
        expect(kept.type).toBe('image/png')
        expect(kept.data.equals(Buffer.from(png, 'base64'))).toBe(true)
    })

    it('tells the type by the bytes, and takes no SVG or anything else', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
        expect(await failure(() => store.createUpload({data: `data:image/png;base64,${svg}`})))
            .toEqual({status: 400, message: "That isn't a PNG, JPEG, GIF or WebP image"})
        expect((await failure(() => store.createUpload({data: 'not base64!'}))).status).toBe(400)
        expect((await failure(() => store.createUpload({data: ''}))).status).toBe(400)
    })

    it('refuses one over the limit', async () => {
        const big = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(UPLOAD_LIMIT)]).toString('base64')
        expect((await failure(() => store.createUpload({data: big}))).message).toMatch(/MB at most/)
    })

    /** A PNG of noise `width` × `height`, as big as a screenshot gets for its size. */
    const noise = (width: number, height: number) => sharp(randomBytes(width * height * 3), {raw: {width, height, channels: 3}}).png().toBuffer()

    it('keeps a PNG or JPEG as WebP when that\'s smaller, no wider than 2,560 px (ORR-446)', async () => {
        const shot = await noise(3000, 40)
        const image = await store.createUpload({data: shot.toString('base64'), name: 'shot.png'})
        expect(image.type).toBe('image/webp')
        expect(image.size).toBeLessThan(shot.length)
        const kept = await store.upload(image.id)
        expect(await sharp(kept.data).metadata()).toMatchObject({format: 'webp', width: 2560, height: 34})
        const jpeg = await sharp(await noise(400, 300)).jpeg({quality: 100}).toBuffer()
        expect((await store.createUpload({data: jpeg.toString('base64')})).type).toBe('image/webp')
    })

    it('keeps a screenshot taller than WebP holds as WebP too, scaled only to fit (ORR-465)', async () => {
        const {compressImage, MAX_HEIGHT} = await import('../server/utils/compress')
        const kept = await compressImage(await noise(200, 20_000), 'image/png')
        expect(kept.type).toBe('image/webp')
        expect(await sharp(kept.data).metadata()).toMatchObject({format: 'webp', height: MAX_HEIGHT, width: 164})
    })

    it("drops a photo's metadata, its place included, whichever way it's kept smaller (ORR-465)", async () => {
        const {compressImage} = await import('../server/utils/compress')
        const photo = await sharp(await noise(600, 400)).jpeg({quality: 100}).withExif({IFD0: {Copyright: 'Ada', Artist: 'Ada Lovelace'}}).toBuffer()
        expect((await sharp(photo).metadata()).exif).toBeDefined()
        const kept = await compressImage(photo, 'image/jpeg')
        expect(kept.data.length).toBeLessThan(photo.length)
        expect((await sharp(kept.data).metadata()).exif).toBeUndefined()
    })

    it('keeps a GIF, a small image and an animated PNG as they came', async () => {
        const gif = await sharp(await noise(300, 300)).gif().toBuffer()
        expect((await store.createUpload({data: gif.toString('base64')})).type).toBe('image/gif')
        expect((await store.createUpload({data: png})).type).toBe('image/png')
        const frames = await noise(300, 300)
        // An `acTL` chunk before the image data is what makes a PNG animated.
        const apng = Buffer.concat([frames.subarray(0, 33), Buffer.from('\0\0\0\x08acTL\0\0\0\x02\0\0\0\0\0\0\0\0', 'latin1'), frames.subarray(33)])
        expect((await store.createUpload({data: apng.toString('base64')})).type).toBe('image/png')
    })

    it('compresses the ones kept before, in place, once', async () => {
        const before = await noise(800, 200)
        await store.db.run('INSERT INTO uploads (id, type, name, size, data, created_by, owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            'a'.repeat(24), 'image/png', 'old.png', before.length, before, 'claude', 0, '2026-10-01T00:00:00.000Z')
        const done = await store.compressUploads()
        expect(done).toMatchObject({images: 1})
        expect(done!.saved).toBeGreaterThan(0)
        expect((await store.upload('a'.repeat(24))).type).toBe('image/webp')
        expect(await store.compressUploads()).toBeNull()
    })

    it("answers 404 for one that isn't there", async () => {
        expect((await failure(() => store.upload('0'.repeat(24)))).status).toBe(404)
        expect((await failure(() => store.upload('../etc'))).status).toBe(404)
    })
})

describe("a doc's past (ORR-675)", () => {
    const owner = {name: 'skoll', owner: true}
    const session = {name: 'claude', owner: false, session: 'orrery · Høne'}
    const texts = async (id: string) => Promise.all((await store.docRevisions('greenhouse', id)).map(async r => (await store.docRevision('greenhouse', id, r.id)).body))

    it('keeps a revision for each save that changes the title or text, however it was saved', async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'one'}, owner)
        await store.updateDoc('greenhouse', 'joints', {body: 'two'}, session)
        await store.putDoc('greenhouse', 'joints', {title: 'Joints', body: 'three'}, session)
        await store.updateDoc('greenhouse', 'joints', {title: 'Hinges'}, owner)
        const revisions = await store.docRevisions('greenhouse', 'joints')
        expect(revisions.map(r => r.title)).toEqual(['Hinges', 'Joints', 'Joints', 'Joints'])
        expect(revisions[0]).not.toHaveProperty('body')
        expect(revisions.map(r => r.created_by)).toEqual(['skoll', 'claude', 'claude', 'skoll'])
        expect(revisions[1]!.session_name).toBe('orrery · Høne')
        expect(revisions[3]).not.toHaveProperty('session_name')
        expect(await texts('joints')).toEqual(['three', 'three', 'two', 'one'])
        // The doc itself reads as it is now.
        expect((await store.doc('greenhouse', 'joints')).body).toBe('three')
    })

    it("doesn't count a move, a new position, or the same text saved again", async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'one'})
        await store.updateDoc('greenhouse', 'joints', {section: 'Decisions'})
        await store.updateDoc('greenhouse', 'joints', {position: 9})
        await store.updateDoc('greenhouse', 'joints', {title: 'Joints', body: 'one'})
        await store.putDoc('greenhouse', 'joints', {title: 'Joints', body: 'one'})
        await store.renameDocSection('greenhouse', 'Decisions', {name: 'Choices'})
        await store.deleteDocSection('greenhouse', 'Choices')
        expect(await store.docRevisions('greenhouse', 'joints')).toHaveLength(1)
    })

    it('restores a revision as a new one, so a restore can be undone', async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'one'})
        await store.updateDoc('greenhouse', 'joints', {title: 'Hinges', body: 'two'})
        const [two, one] = await store.docRevisions('greenhouse', 'joints')
        const {doc, created} = await store.restoreDoc('greenhouse', 'joints', one!.id, session)
        expect([doc.title, doc.body, created]).toEqual(['Joints', 'one', false])
        const after = await store.docRevisions('greenhouse', 'joints')
        expect(after).toHaveLength(3)
        expect(after[0]).toMatchObject({title: 'Joints', created_by: 'claude'})
        expect((await store.restoreDoc('greenhouse', 'joints', two!.id)).doc.body).toBe('two')
        // Restoring what it already says is a save that changes nothing.
        expect((await store.restoreDoc('greenhouse', 'joints', two!.id)).doc.body).toBe('two')
        expect(await texts('joints')).toEqual(['two', 'one', 'two', 'one'])
    })

    it('refuses a revision that is not of this doc, or no revision at all', async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'one'})
        await store.createDoc('greenhouse', {id: 'gears', title: 'Gears', body: 'two'})
        const [gears] = await store.docRevisions('greenhouse', 'gears')
        expect((await failure(() => store.docRevision('greenhouse', 'joints', gears!.id))).status).toBe(404)
        expect((await failure(() => store.restoreDoc('greenhouse', 'joints', gears!.id))).status).toBe(404)
        for (const bad of [Number.NaN, 0, -1, 1.5, 2 ** 40]) expect((await failure(() => store.docRevision('greenhouse', 'joints', bad))).status).toBe(404)
        expect((await failure(() => store.docRevisions('greenhouse', 'never'))).status).toBe(404)
    })

    it('brings a deleted doc back, filed where it was and made by who made it', async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'one', section: 'Decisions'}, owner)
        await store.updateDoc('greenhouse', 'joints', {body: 'two', section: 'How it works'}, session)
        await store.deleteDoc('greenhouse', 'joints', owner)
        expect((await failure(() => store.doc('greenhouse', 'joints'))).status).toBe(404)
        expect((await store.listDocs('greenhouse')).map(d => d.id)).toEqual([])

        const [gone] = await store.deletedDocs('greenhouse')
        expect(gone).toMatchObject({id: 'joints', title: 'Joints', summary: 'two', deleted_by: 'skoll'})
        expect((await store.docRevisions('greenhouse', 'joints'))[0]).toMatchObject({id: gone!.revision, deleted: true})

        const {doc, created} = await store.restoreDoc('greenhouse', 'joints', gone!.revision, session)
        expect(created).toBe(true)
        expect(doc).toMatchObject({body: 'two', section: 'How it works', created_by: 'skoll', protected: true})
        expect(await store.deletedDocs('greenhouse')).toEqual([])
        // Back, it still has its past, and a session still can't remove what the owner made.
        expect(await texts('joints')).toEqual(['two', 'two', 'two', 'one'])
        expect((await failure(() => store.deleteDoc('greenhouse', 'joints', session))).status).toBe(403)
    })

    it('carries on the history of a deleted doc when one is made again at its id', async () => {
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'old'})
        await store.deleteDoc('greenhouse', 'joints')
        await store.createDoc('greenhouse', {title: 'Joints', body: 'new'})
        expect(await store.deletedDocs('greenhouse')).toEqual([])
        expect(await texts('joints')).toEqual(['new', 'old', 'old'])
    })

    it('goes with its project, and only then', async () => {
        await store.createProject({name: 'other', key: 'OTH'})
        await store.createDoc('other', {id: 'joints', title: 'Joints', body: 'theirs'})
        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'ours'})
        await store.deleteProject('other')
        expect(await texts('joints')).toEqual(['ours'])
        await store.createProject({name: 'other', key: 'OTH'})
        expect((await failure(() => store.docRevisions('other', 'joints'))).status).toBe(404)
    })

    it('marks a release with the newest revision as it ships, across projects', async () => {
        await store.updateProject('greenhouse', {release_mode: 'own'})
        await store.createRelease('greenhouse', {version: '1.0.0'})
        expect((await store.createRelease('greenhouse', {version: '0.0.1', shipped_on: '2026-01-01'})).doc_mark).toBe(0)
        expect((await store.release('greenhouse', '1.0.0')).doc_mark).toBeUndefined()

        await store.createDoc('greenhouse', {id: 'joints', title: 'Joints', body: 'shipped'})
        await store.createProject({name: 'other', key: 'OTH'})
        await store.createDoc('other', {id: 'gears', title: 'Gears', body: 'any project counts'})
        const [newest] = await store.docRevisions('other', 'gears')
        const shipped = await store.updateRelease('greenhouse', '1.0.0', {shipped_on: '2026-10-30'})
        expect(shipped.doc_mark).toBe(newest!.id)

        // A doc as of the release is its newest revision at or below the mark.
        await store.updateDoc('greenhouse', 'joints', {body: 'later'})
        const asOf = (await store.docRevisions('greenhouse', 'joints')).find(r => r.id <= shipped.doc_mark!)
        expect((await store.docRevision('greenhouse', 'joints', asOf!.id)).body).toBe('shipped')

        // A new day keeps the mark, un-shipping lets go of it, and shipping again marks anew.
        expect((await store.updateRelease('greenhouse', '1.0.0', {shipped_on: '2026-10-31'})).doc_mark).toBe(newest!.id)
        expect((await store.updateRelease('greenhouse', '1.0.0', {notes: 'Hello'})).doc_mark).toBe(newest!.id)
        expect((await store.updateRelease('greenhouse', '1.0.0', {shipped_on: null})).doc_mark).toBeUndefined()
        const [latest] = await store.docRevisions('greenhouse', 'joints')
        expect((await store.updateRelease('greenhouse', '1.0.0', {shipped_on: '2026-11-01'})).doc_mark).toBe(latest!.id)
    })
})
