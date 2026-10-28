import {mkdtempSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {openDb} from '../server/utils/db'

// The WAL file is cut back once it's checkpointed (ORR-465): left alone it stays as big as it once grew, which after
// a VACUUM is as big as the whole database, and the database's size in App settings counts it.
describe('the WAL', () => {
    it('is cut back to 8 MB at most once checkpointed, however big it grew', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-wal-')), 'orrery.db')
        const db = openDb(path)
        db.exec('PRAGMA wal_autocheckpoint = 0')
        db.exec('CREATE TABLE filler (data BLOB)')
        const insert = db.prepare('INSERT INTO filler (data) VALUES (randomblob(1048576))')
        for (let i = 0; i < 20; i++) insert.run()
        expect(statSync(`${path}-wal`).size).toBeGreaterThan(16 * 1024 * 1024)
        db.exec('PRAGMA wal_checkpoint(PASSIVE)')
        db.exec('INSERT INTO filler (data) VALUES (randomblob(1024))')
        db.exec('PRAGMA wal_checkpoint(PASSIVE)')
        expect(statSync(`${path}-wal`).size).toBeLessThanOrEqual(8 * 1024 * 1024)
        db.close()
    })
})
