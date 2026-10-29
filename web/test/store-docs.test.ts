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
