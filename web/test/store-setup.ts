// What every store test starts from (ORR-500): a fresh database (SQLite, or Postgres with TEST_POSTGRES_URL) with the
// project `greenhouse` and its chunk, and the projects the store has said changed since.
import {Store} from '../server/utils/store'
import {testDb} from './db'

export async function storeSetup(): Promise<{store: Store, changes: string[]}> {
    const changes: string[] = []
    const store = new Store(testDb(), project => changes.push(project))
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createChunk('greenhouse', {title: 'Moving parts: joints'})
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
