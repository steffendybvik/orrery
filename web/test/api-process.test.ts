// The Rust API as this server runs it (ORR-1035): started again on the new database after a move, the one before
// stopped and no longer heard, and a request with the swap on waiting for it to listen rather than failing at once.
import {EventEmitter} from 'node:events'
import type {ChildProcess} from 'node:child_process'
import {afterEach, describe, expect, it} from 'vitest'
import {ApiProcess} from '../server/utils/api-process'
import {apiListening, apiStarted, apiStarting, apiTarget} from '../server/utils/api-router'

/** A stand-in for the binary: says it's serving when told, and exits when killed. */
class FakeApi extends EventEmitter {
    stderr = new EventEmitter()
    killed = false
    constructor(readonly env: Record<string, string>) {
        super()
    }
    listen(port: number) {
        this.stderr.emit('data', Buffer.from(`serving docs on http://127.0.0.1:${port}, …\n`))
    }
    kill() {
        this.killed = true
        setTimeout(() => this.emit('exit', null), 0)
        return true
    }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

function running(database: {now: string}) {
    const spawned: FakeApi[] = []
    const stopped: (number | null)[] = []
    const api = new ApiProcess({
        spawn: env => {
            const child = new FakeApi(env)
            spawned.push(child)
            return child as unknown as ChildProcess
        },
        database: async () => database.now,
        stopped: code => stopped.push(code),
    })
    return {api, spawned, stopped}
}

afterEach(() => {
    apiStarted(null)
    apiStarting(false)
})

describe('the Rust API this server runs', () => {
    it('starts again on the new database after a move, and stops hearing the one before', async () => {
        const database = {now: '/data/orrery.db'}
        const {api, spawned, stopped} = running(database)
        await api.start()
        spawned[0]!.listen(4001)
        expect(spawned[0]!.env.NUXT_DATABASE).toBe('/data/orrery.db')
        expect(apiTarget({})?.url).toBe('http://127.0.0.1:4001')

        database.now = '/elsewhere/orrery.db'
        await api.restart()
        expect(spawned[0]!.killed).toBe(true)
        expect(spawned).toHaveLength(2)
        expect(spawned[1]!.env.NUXT_DATABASE).toBe('/elsewhere/orrery.db')
        expect(spawned[1]!.env.NUXT_API_TOKEN).not.toBe(spawned[0]!.env.NUXT_API_TOKEN)
        // Nothing goes to the old one while the new one starts.
        expect(apiTarget({})).toBeNull()

        await tick()
        // The old one's exit, and anything it says, is the old one's: the new one is still the one starting.
        spawned[0]!.listen(4001)
        expect(apiTarget({})).toBeNull()
        expect(stopped).toEqual([])

        spawned[1]!.listen(4002)
        expect(apiTarget({})?.url).toBe('http://127.0.0.1:4002')
        api.stop()
    })

    it('says so when the one running stops by itself, and not when it was stopped', async () => {
        const {api, spawned, stopped} = running({now: '/data/orrery.db'})
        await api.start()
        spawned[0]!.listen(4001)
        spawned[0]!.emit('exit', 1)
        expect(stopped).toEqual([1])
        expect(apiTarget({})).toBeNull()

        await api.restart()
        api.stop()
        await tick()
        expect(stopped).toEqual([1])
    })

    it('holds a request while it starts, until it listens', async () => {
        const {api, spawned} = running({now: '/data/orrery.db'})
        await api.start()
        let waited = false
        const wait = apiListening(1000).then(() => waited = true)
        await tick()
        expect(waited).toBe(false)
        spawned[0]!.listen(4001)
        await wait
        expect(apiTarget({})?.url).toBe('http://127.0.0.1:4001')
        api.stop()
    })

    it('lets a request go after a while, or once it gives up starting', async () => {
        const {api, spawned} = running({now: '/data/orrery.db'})
        await api.start()
        const started = Date.now()
        await apiListening(30)
        expect(Date.now() - started).toBeGreaterThanOrEqual(25)

        const wait = apiListening(1000)
        spawned[0]!.emit('exit', 1)
        await wait
        expect(apiTarget({})).toBeNull()
        // Nothing is starting it now, so nothing waits.
        const at = Date.now()
        await apiListening(1000)
        expect(Date.now() - at).toBeLessThan(50)
        api.stop()
    })
})
