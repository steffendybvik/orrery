// The Rust API as this server runs it (plugins/api.ts, ORR-922): started on the database this server is on, and started
// again on the new one when the owner moves it from App settings or restores a backup (ORR-1035), as the API stays on
// the database it started on and answers every request for another with a 421.
import type {ChildProcess} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {known} from '#shared/known'
import {apiStarted, apiStarting} from './api-router'

export interface ApiProcessOptions {
    /** Starts the binary with this environment added, as `spawn` does. */
    spawn: (env: Record<string, string>) => ChildProcess
    /** The database to start it on, once that's open and migrated (by `orrery-api migrate`, as it opened). */
    database: () => Promise<string>
    /** Said when it stopped by itself, not because this asked. */
    stopped?: (code: number | null) => void
    failed?: (error: Error) => void
}

/** Runs one API at a time: `start` begins one, `restart` stops the one running and begins another (each a token of its
 * own), `stop` ends it. Only the one running now tells the router it's listening or gone. */
export class ApiProcess {
    private child: ChildProcess | null = null
    private closed = false
    /** Which start is the latest: one a restart overtook, still waiting on the database, starts nothing. */
    private starts = 0

    constructor(private readonly options: ApiProcessOptions) {}

    async start() {
        if (this.closed) return
        const mine = ++this.starts
        apiStarting(true)
        let database: string
        try {
            database = await this.options.database()
        } catch (error) {
            if (mine === this.starts) apiStarting(false)
            throw error
        }
        if (this.closed || mine !== this.starts) return
        const token = randomBytes(24).toString('hex')
        const api = this.options.spawn({NUXT_API_TOKEN: token, NUXT_DATABASE: database, ORRERY_API_LISTEN: '127.0.0.1:0'})
        this.child = api
        const current = () => this.child === api
        let said = ''
        known(api.stderr ?? undefined, "the API's stderr").on('data', (chunk: Buffer) => {
            process.stderr.write(chunk)
            said += chunk
            const at = /serving docs on (http:\/\/\S+),/.exec(said)
            if (at) {
                if (current()) apiStarted({url: known(at[1], 'the address it serves on'), token})
                said = ''
            }
        })
        api.on('error', error => {
            if (!current()) return
            this.child = null
            apiStarted(null)
            apiStarting(false)
            this.options.failed?.(error)
        })
        api.on('exit', code => {
            if (!current()) return
            this.child = null
            apiStarted(null)
            apiStarting(false)
            if (!this.closed) this.options.stopped?.(code)
        })
    }

    /** Stops the one running, if one is, and starts another, on the database this server is on now. */
    async restart() {
        apiStarting(true)
        this.end()
        await this.start()
    }

    stop() {
        this.closed = true
        this.end()
        apiStarting(false)
    }

    private end() {
        const child = this.child
        this.child = null
        apiStarted(null)
        child?.kill()
    }
}
