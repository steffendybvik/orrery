import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A connect request on the server (ORR-708): one launcher takes it, only it reports on it and hears its write, and the
// server has no way to name a folder. The requests live in the module, so each test gets a fresh one.
let connects: typeof import('../server/utils/connects')
let events: EventEmitter
let sent: Record<string, unknown>[]
const ORRERY = {id: 'orr_1', environment: 'personal'}
const PROJECTS = [{id: 'shop', key: 'SHO'}]
const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})

beforeEach(async () => {
    vi.resetModules()
    events = new EventEmitter()
    sent = []
    events.on('connects', event => sent.push(event))
    vi.stubGlobal('projectEvents', events)
    vi.stubGlobal('conflict', error(409))
    vi.stubGlobal('notFound', error(404))
    vi.stubGlobal('forbidden', error(403))
    vi.stubGlobal('badRequest', error(400))
    connects = await import('../server/utils/connects')
})
afterEach(() => vi.unstubAllGlobals())

describe('a connect request', () => {
    it('needs a launcher that can open a picker', () => {
        expect(() => connects.askConnect()).toThrow(/No launcher/)
        const done = connects.addPicker('laptop')
        expect(connects.pickersConnected()).toBe(1)
        expect(connects.askConnect().state).toBe('asking')
        expect(sent).toHaveLength(1)
        expect(Object.keys(sent[0]!).sort()).toEqual(['id', 'type'])
        done()
        expect(connects.pickersConnected()).toBe(0)
    })

    it('goes to the first launcher to take it, which alone reports on it', () => {
        const [a, b] = [connects.addPicker('laptop'), connects.addPicker('desktop')]
        const {id} = connects.askConnect()
        expect(connects.reportConnect(id, a.token, {state: 'picking'})).toBe(true)
        expect(connects.reportConnect(id, b.token, {state: 'picking'})).toBe(false)
        expect(connects.reportConnect(id, b.token, {state: 'picked', folder: 'evil'})).toBe(false)
        expect(connects.connectOf(id)).toMatchObject({state: 'picking', host: 'laptop'})
        expect(connects.reportConnect(id, a.token, {state: 'picked', folder: 'shop', projects: ['cart']})).toBe(true)
        expect(connects.connectOf(id)).toMatchObject({state: 'picked', folder: 'shop', projects: ['cart']})
    })

    it("refuses a report without a connected launcher's token, and never shows the token", () => {
        const a = connects.addPicker('laptop')
        const {id} = connects.askConnect()
        expect(() => connects.reportConnect(id, undefined, {state: 'picking'})).toThrow(/connected launcher/)
        expect(() => connects.reportConnect(id, 'made-up', {state: 'picking'})).toThrow(/connected launcher/)
        connects.reportConnect(id, a.token, {state: 'picking'})
        expect(JSON.stringify(connects.connectOf(id))).not.toContain(a.token)
    })

    it('writes only once a folder is chosen, through the launcher that has it', () => {
        const [a] = [connects.addPicker('laptop'), connects.addPicker('desktop')]
        const {id} = connects.askConnect()
        expect(() => connects.writeConnect(id, PROJECTS, ORRERY, 'iterm')).toThrow(/no chosen folder/)
        connects.reportConnect(id, a.token, {state: 'picking'})
        connects.reportConnect(id, a.token, {state: 'picked', folder: 'shop'})
        expect(() => connects.writeConnect(id, [], ORRERY, 'iterm')).toThrow(/Tick at least one/)
        expect(connects.writeConnect(id, PROJECTS, ORRERY, 'iterm').state).toBe('writing')
        expect(sent.at(-1)).toEqual({type: 'write', id, token: a.token, projects: PROJECTS, orrery: ORRERY, terminal: 'iterm'})
        expect(() => connects.writeConnect(id, PROJECTS, ORRERY, 'iterm')).toThrow(/no chosen folder/)
        connects.reportConnect(id, a.token, {state: 'done', written: ['.mcp.json'], opened: true})
        expect(connects.connectOf(id)).toMatchObject({state: 'done', written: ['.mcp.json'], opened: true})
    })

    it("lets a repo with projects already go on with none ticked, and one serving them all", () => {
        const a = connects.addPicker('laptop')
        const {id} = connects.askConnect()
        connects.reportConnect(id, a.token, {state: 'picking'})
        connects.reportConnect(id, a.token, {state: 'picked', folder: 'shop', every: true})
        expect(connects.writeConnect(id, [], ORRERY, 'iterm').state).toBe('writing')
    })

    it('fails what a launcher had taken on when it goes, and takes no reports out of turn', () => {
        const a = connects.addPicker('laptop')
        const b = connects.addPicker('desktop')
        const {id} = connects.askConnect()
        connects.reportConnect(id, a.token, {state: 'done'})
        expect(connects.connectOf(id).state).toBe('asking')
        connects.reportConnect(id, a.token, {state: 'picking'})
        expect(connects.currentConnect()?.id).toBe(id)
        a()
        expect(connects.connectOf(id)).toMatchObject({state: 'failed', message: expect.stringContaining('launcher went')})
        expect(connects.currentConnect()).toBeUndefined()
        expect(() => connects.connectOf('nope')).toThrow(/No connect request/)
        b()
    })
})
