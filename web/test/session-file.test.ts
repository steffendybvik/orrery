import {mkdtempSync, utimesSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {readSessionFile, waitForSessionFile, writeSessionFile} from '../../channel/session-file.mjs'
// @ts-expect-error: plain JavaScript, no types
import {sessionHeaders} from '../../channel/mcp-beside.mjs'

// Which session a hand-opened `claude` is, for the install line's `/mcp` entry (ORR-1102).
describe("a session's file for /mcp", () => {
    const dir = () => mkdtempSync(join(tmpdir(), 'orrery-sessions-'))

    it('says who calls as the channel does, the chat and an untrusted session included', () => {
        expect(sessionHeaders({session: 's1', person: 'steffen'})).toEqual({'Orrery-Actor': 'claude', 'Orrery-Session': 's1', 'Orrery-Person': 'steffen'})
        expect(sessionHeaders({session: 's1', untrusted: true})).toEqual({'Orrery-Actor': 'claude', 'Orrery-Session': 's1', 'Orrery-Untrusted': 'yes'})
        expect(sessionHeaders({session: 's1', chat: 'l1'})).toEqual({'Orrery-Actor': 'claude', 'Orrery-Session': 's1', 'Orrery-Chat': 'yes', 'Orrery-Launch': 'l1'})
        expect(sessionHeaders({})).toEqual({'Orrery-Actor': 'claude'})
    })

    it("is read for its claude's pid, and taken away by the channel that wrote it", () => {
        const where = dir()
        const headers = sessionHeaders({session: 's1'})
        const remove = writeSessionFile(4242, headers, where)
        expect(readSessionFile(4242, {dir: where})).toEqual(headers)
        expect(readSessionFile(4243, {dir: where})).toBeUndefined()
        remove()
        expect(readSessionFile(4242, {dir: where})).toBeUndefined()
    })

    it("leaves one another session wrote since alone as it exits", () => {
        const where = dir()
        const remove = writeSessionFile(4242, sessionHeaders({session: 's1'}), where)
        writeSessionFile(4242, sessionHeaders({session: 's2'}), where)
        remove()
        expect(readSessionFile(4242, {dir: where})?.['Orrery-Session']).toBe('s2')
    })

    it("isn't taken from an earlier process with the same pid", () => {
        const where = dir()
        writeSessionFile(4242, sessionHeaders({session: 'old'}), where)
        const hourAgo = new Date(Date.now() - 3_600_000)
        utimesSync(join(where, '4242'), hourAgo, hourAgo)
        expect(readSessionFile(4242, {dir: where, started: Date.now() - 60_000})).toBeUndefined()
        expect(readSessionFile(4242, {dir: where, started: Date.now() - 7_200_000})?.['Orrery-Session']).toBe('old')
    })

    it('is waited for while the channel starts, and given up on after a while', async () => {
        const where = dir()
        setTimeout(() => writeSessionFile(4242, sessionHeaders({session: 's1'}), where), 50)
        expect((await waitForSessionFile(4242, {dir: where, within: 2000, every: 10, started: undefined}))?.['Orrery-Session']).toBe('s1')
        expect(await waitForSessionFile(4243, {dir: where, within: 50, every: 10, started: undefined})).toBeUndefined()
    })
})
