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

    it("runs what waits on a transaction once it commits, outside it, and never when it's taken back", async () => {
        const db = await fresh()
        const ran: string[] = []
        const after = (what: string) => db.afterCommit(async () => {
            // Outside the transaction: a write of its own lands, though it's long done.
            await db.run('INSERT INTO log (what) VALUES (?)', what)
            ran.push(what)
        })
        await db.transaction(async () => {
            await db.run('INSERT INTO log (what) VALUES (?)', 'kept')
            after('after kept')
            await tick()
            expect(ran).toEqual([])
        })
        await db.transaction(async () => {
            await db.run('INSERT INTO log (what) VALUES (?)', 'lost')
            after('after lost')
            throw new Error('take it back')
        }).catch(() => {})
        after('alone')
        await tick()
        await tick()
        expect(ran).toEqual(['after kept', 'alone'])
        expect((await db.all<{what: string}>('SELECT what FROM log ORDER BY id')).map(r => r.what)).toEqual(['kept', 'after kept', 'alone'])
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

describe('the Postgres driver', () => {
    it('numbers the placeholders, leaving quoted text alone', async () => {
        const {numbered} = await import('../server/utils/postgres')
        expect(numbered("SELECT * FROM t WHERE a = ? AND b IN (?, ?) AND c = '?' AND d = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b IN ($2, $3) AND c = '?' AND d = $4")
    })
})
