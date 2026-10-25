import {describe, expect, it} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {SqliteDb} from '../server/utils/database'

const fresh = async () => {
    const db = new SqliteDb(new DatabaseSync(':memory:'))
    await db.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, what TEXT)')
    return db
}
const tick = () => new Promise(resolve => setTimeout(resolve, 1))

describe('the SQLite driver', () => {
    it("keeps transactions from interleaving, however long they wait between statements", async () => {
        const db = await fresh()
        const write = (who: string) => db.transaction(async () => {
            await db.run('INSERT INTO log (what) VALUES (?)', `${who} 1`)
            await tick()
            await db.run('INSERT INTO log (what) VALUES (?)', `${who} 2`)
        })
        await Promise.all([write('a'), write('b'), db.run('INSERT INTO log (what) VALUES (?)', 'c')])
        expect((await db.all<{what: string}>('SELECT what FROM log ORDER BY id')).map(r => r.what)).toEqual(['a 1', 'a 2', 'b 1', 'b 2', 'c'])
    })

    it('takes back all of a transaction that fails, and carries on after it', async () => {
        const db = await fresh()
        await expect(db.transaction(async () => {
            await db.run('INSERT INTO log (what) VALUES (?)', 'lost')
            throw new Error('no')
        })).rejects.toThrow('no')
        await db.run('INSERT INTO log (what) VALUES (?)', 'kept')
        expect(await db.all('SELECT what FROM log')).toEqual([{what: 'kept'}])
    })

    it('runs one transaction inside another as part of it', async () => {
        const db = await fresh()
        await db.transaction(() => db.transaction(() => db.run('INSERT INTO log (what) VALUES (?)', 'inner')))
        expect(await db.get('SELECT count(*) AS n FROM log')).toEqual({n: 1})
    })

    it('hands over the raw connection only between transactions', async () => {
        const db = await fresh()
        const seen: number[] = []
        await Promise.all([
            db.transaction(async () => {
                await db.run('INSERT INTO log (what) VALUES (?)', 'x')
                await tick()
            }),
            db.alone(raw => seen.push((raw.prepare('SELECT count(*) AS n FROM log').get() as {n: number}).n)),
        ])
        expect(seen).toEqual([1])
    })
})
