// A stand-in for the Rust API's session work and signals (ORR-1135), for a test with no API of its own whose set-up only
// sets them off on the way (a comment, a focus): no session is on anything, and a signal goes nowhere, unless the test
// names a database (`keepSignalsIn`), where it's kept as the API would keep it. Everything else goes to the real router.
//
//     vi.mock('../server/utils/api-router', async original => (await import('./no-sessions')).noSessions(await original()))
import type {Db} from '../server/utils/database'
import type {SignalRow} from '../server/store/schema'
import {signalOf, stamp} from '../server/store/schema'

let kept: Db | null = null

/** Keeps the signals the store sends in `db` from now on (null: they go nowhere), and lists them from there. */
export function keepSignalsIn(db: Db | null) {
    kept = db
}

type Router = {readFromApiOnly: (path: string, ...rest: never[]) => Promise<unknown>, writeToApiOnly: (method: string, path: string, body: unknown, ...rest: never[]) => Promise<unknown>}

export function noSessions<T extends Router>(router: T): T {
    return {
        ...router,
        readFromApiOnly: async (path: string, ...rest: never[]) => {
            const url = new URL(path, 'http://api')
            const at = url.pathname
            if (at.endsWith('/workers') || at.endsWith('/dependents') || (at.endsWith('/signals') && (url.searchParams.has('waiting') || url.searchParams.has('focused')))) return []
            if (at.endsWith('/issue-sessions')) return {issues: [], waiting: false, waiting_for: false}
            if (at.endsWith('/comments/unanswered')) return []
            if (at.endsWith('/signals/last')) return {id: Number((await kept?.get<{id: number | null}>('SELECT MAX(id) AS id FROM signals'))?.id ?? 0)}
            if (at.endsWith('/signals')) {
                const project = decodeURIComponent(at.split('/')[3]!)
                return kept ? (await kept.all<SignalRow>('SELECT * FROM signals WHERE project = ? AND id > ? ORDER BY id LIMIT 50', project, Number(url.searchParams.get('after') ?? 0))).map(signalOf) : []
            }
            return await router.readFromApiOnly(path, ...rest)
        },
        writeToApiOnly: async (method: string, path: string, body: unknown, ...rest: never[]) => {
            if (path.endsWith('/worked-by') || path.endsWith('/signals/retarget') || path.endsWith('/issue-sessions/rename')) return null
            if (method === 'POST' && path.endsWith('/signals')) {
                const project = decodeURIComponent(path.split('/')[3]!)
                const {instructions, owned, ...fields} = body as Record<string, string | number | boolean | string[] | null>
                if (!kept) return {id: 0, project, delivered_to: [], created_at: stamp(), ...fields, protected: !!owned}
                const columns: [string, string | number | null][] = [['project', project], ...Object.entries(fields) as [string, string | number | null][],
                    ['owned', Number(!!owned)], ['created_at', stamp()]]
                if (instructions) columns.push(['instructions', JSON.stringify(instructions)])
                const row = await kept.get<SignalRow>(`INSERT INTO signals (${columns.map(([name]) => name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
                    ...columns.map(([, value]) => value))
                return signalOf(row!)
            }
            return await router.writeToApiOnly(method, path, body, ...rest)
        },
    }
}
