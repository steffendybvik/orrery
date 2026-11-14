import {beforeEach, describe, expect, it, vi} from 'vitest'
import {forgetLostData, LOST_DATA, noteUnknownCredential} from '../server/utils/lost-data'

// Where a Docker orrery's data may be (ORR-1180): a brand-new install is empty too, so nothing is said as it starts;
// a key or login it doesn't know, coming to an empty one in Docker, is the sign it had data, said once.
const here = vi.hoisted(() => ({docker: true, fresh: true, notes: [] as {kind: string, message: string}[]}))
vi.mock('../server/utils/host-paths', () => ({inDocker: () => here.docker}))
vi.mock('../server/utils/database-state', () => ({databaseFresh: async () => here.fresh}))
vi.stubGlobal('useEventLog', () => ({note: (line: {kind: string, message: string}) => here.notes.push(line)}))
vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => {
    forgetLostData()
    Object.assign(here, {docker: true, fresh: true, notes: []})
})

describe('noteUnknownCredential', () => {
    it('says where the data may be once, on an empty Docker orrery', async () => {
        await noteUnknownCredential()
        await noteUnknownCredential()
        expect(here.notes).toEqual([{level: 'warn', kind: 'database.empty', message: LOST_DATA}])
        expect(LOST_DATA).toMatch(/docker volume ls/)
    })

    it('says nothing on a database with data, or outside Docker', async () => {
        here.fresh = false
        await noteUnknownCredential()
        forgetLostData()
        Object.assign(here, {fresh: true, docker: false})
        await noteUnknownCredential()
        expect(here.notes).toEqual([])
    })
})
