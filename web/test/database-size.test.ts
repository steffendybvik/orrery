import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import type {Db} from '../server/utils/database'
import {databaseSize} from '../server/utils/database-size'
import {bytes} from '../app/utils/bytes'

const none = {} as Db

describe("the database's size", () => {
    it('is a SQLite file with its -wal, and the backup folder with what is in it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-size-'))
        writeFileSync(join(dir, 'orrery.db'), Buffer.alloc(4096))
        writeFileSync(join(dir, 'orrery.db-wal'), Buffer.alloc(1000))
        mkdirSync(join(dir, 'backup', 'old'), {recursive: true})
        writeFileSync(join(dir, 'backup', 'orrery-1.db'), Buffer.alloc(300))
        writeFileSync(join(dir, 'backup', 'old', 'orrery-0.db'), Buffer.alloc(200))
        expect(await databaseSize({kind: 'sqlite', where: join(dir, 'orrery.db'), backup: join(dir, 'backup')}, none)).toEqual({size: 5096, backup_size: 500})
    })

    it('leaves out what is not there yet', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-size-'))
        expect(await databaseSize({kind: 'sqlite', where: join(dir, 'orrery.db'), backup: join(dir, 'backup')}, none)).toEqual({})
    })

    it('is what Postgres says, or nothing when it may not say', async () => {
        const answers = (size: unknown) => ({get: async () => size instanceof Error ? Promise.reject(size) : {size}}) as unknown as Db
        expect(await databaseSize({kind: 'postgres', where: 'u@h/orrery'}, answers('8331935'))).toEqual({size: 8331935})
        expect(await databaseSize({kind: 'postgres', where: 'u@h/orrery'}, answers(new Error('permission denied')))).toEqual({})
    })

    it('reads as people read sizes', () => {
        expect([bytes(812), bytes(48_000), bytes(12_431_000), bytes(1_000_000), bytes(250_000_000), bytes(3_200_000_000)]).toEqual(['812 B', '48 KB', '12.4 MB', '1 MB', '250 MB', '3.2 GB'])
    })
})
