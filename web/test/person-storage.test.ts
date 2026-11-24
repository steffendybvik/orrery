import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {forgetPerson, holdStorageTo, STORAGE_PERSON} from '../app/utils/person-storage'

// What the browser keeps is one person's (ORR-1391): it goes when they log out or someone else signs in, and only the
// device's layout stays.
function storage(entries: Record<string, string>): Storage {
    const kept = new Map(Object.entries(entries))
    return {
        get length() { return kept.size },
        key: i => [...kept.keys()][i] ?? null,
        getItem: k => kept.get(k) ?? null,
        setItem: (k, v) => void kept.set(k, String(v)),
        removeItem: k => void kept.delete(k),
        clear: () => kept.clear(),
    }
}
const keys = (s: Storage) => Array.from({length: s.length}, (_, i) => s.key(i)).sort()

const theirs = {
    'orrery-read-docs': '{"orrery/secret-plan":"the whole text"}',
    'orrery-seen': '{"orrery/ORR-1":"2026-11-23"}',
    'orrery-chat-project': 'orrery',
    'orrery-welcome:default': 'done',
    'orrery-docs-folded:orrery': '[]',
}
const device = {'orrery-theme': 'dark', 'orrery-doc-size': 'large', 'other-app': 'kept'}

describe('forgetPerson', () => {
    it("drops a person's keys and keeps the device's and other apps'", () => {
        const s = storage({...theirs, ...device, [STORAGE_PERSON]: 'ada'})
        forgetPerson(s)
        expect(keys(s)).toEqual(Object.keys(device).sort())
    })
})

describe('holdStorageTo', () => {
    it('keeps what the same person had', () => {
        const s = storage({...theirs, [STORAGE_PERSON]: 'ada'})
        holdStorageTo('ada', s)
        expect(s.getItem('orrery-read-docs')).toBe(theirs['orrery-read-docs'])
    })

    it("drops another person's before keeping it for this one", () => {
        const s = storage({...theirs, ...device, [STORAGE_PERSON]: 'ada'})
        holdStorageTo('grace', s)
        expect(s.getItem('orrery-read-docs')).toBeNull()
        expect(s.getItem('orrery-seen')).toBeNull()
        expect(s.getItem('orrery-theme')).toBe('dark')
        expect(s.getItem(STORAGE_PERSON)).toBe('grace')
    })

    // A browser from before this was its one person's, so whoever signs in first keeps it.
    it('keeps what a browser with nobody named had', () => {
        const s = storage({...theirs})
        holdStorageTo('ada', s)
        expect(s.getItem('orrery-seen')).toBe(theirs['orrery-seen'])
        expect(s.getItem(STORAGE_PERSON)).toBe('ada')
    })
})

// The API's answers are one person's, so none are kept in the browser's cache.
describe('0-no-store', () => {
    type Event = {path: string, headers: Record<string, string>}
    let handler: (event: Event) => void
    beforeEach(async () => {
        vi.stubGlobal('defineEventHandler', (h: unknown) => h)
        vi.stubGlobal('setResponseHeader', (event: Event, name: string, value: string) => { event.headers[name] = value })
        vi.resetModules()
        handler = (await import('../server/middleware/0-no-store')).default as unknown as typeof handler
    })
    afterEach(() => vi.unstubAllGlobals())

    it('sends no-store on /api and nothing elsewhere', () => {
        for (const [path, sent] of [['/api/projects', 'no-store'], ['/api', 'no-store'], ['/mine', undefined], ['/apiary', undefined]] as const) {
            const event = {path, headers: {}} as Event
            handler(event)
            expect(event.headers['Cache-Control'], path).toBe(sent)
        }
    })
})
