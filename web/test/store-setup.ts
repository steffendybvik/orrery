// What every store test starts from (ORR-500): a fresh database (SQLite, or Postgres with TEST_POSTGRES_URL) with the
// project `greenhouse` and its milestone, and the projects the store has said changed since.
import {Store} from '../server/utils/store'
import {testDb} from './db'
import {apiTestDb, withApi} from './api'

export async function storeSetup({api = false} = {}): Promise<{store: Store, changes: string[]}> {
    const changes: string[] = []
    const store = new Store(api ? apiTestDb() : testDb(), project => changes.push(project))
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createMilestone('greenhouse', {title: 'Moving parts: joints'})
    // `api`: the Rust API runs on its database, and the router reads and writes through it (ORR-1163).
    if (api) await withApi(store)
    return {store, changes}
}

/** The status code and message a call fails with. */
export async function failure(call: () => unknown): Promise<{status: number, message: string}> {
    try {
        await call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}
