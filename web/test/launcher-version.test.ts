import {describe, expect, it} from 'vitest'

import {CODE, codeOnDisk, launcherMove, servedOtherCode, VERSION} from '../../channel/version.mjs'

const behind = {theirs: ['1.0.0-rc.11'], mine: '1.0.0-rc.10', code: 'a', service: true}

describe("a launcher on other code than its orrery's", () => {
    it('restarts once its checkout holds new code', () => {
        expect(launcherMove({...behind, now: 'b', busy: 0})).toBe('restart')
    })

    it('waits while a restart would cut something off', () => {
        expect(launcherMove({...behind, now: 'b', busy: 1})).toBe('wait')
    })

    it('says to update the checkout while that still holds the code it runs, rather than restarting on it again', () => {
        expect(launcherMove({...behind, now: 'a', busy: 0})).toBe('tell')
        expect(launcherMove({...behind, now: undefined, busy: 0})).toBe('tell')
    })

    it('does nothing in a terminal, or when every orrery it serves runs its code and its checkout holds it', () => {
        expect(launcherMove({...behind, now: 'b', busy: 0, service: false})).toBeNull()
        expect(launcherMove({...behind, theirs: ['1.0.0-rc.10', '1.0.0-rc.10'], now: 'a', busy: 0})).toBeNull()
    })

    it("knows its own version, from the checkout's web/package.json", async () => {
        const {version} = (await import('../package.json')).default
        expect(VERSION).toBe(version)
    })
})

describe('a launcher whose checkout moves on within a version (ORR-470)', () => {
    const same = {theirs: ['1.0.0-rc.10'], mine: '1.0.0-rc.10', code: 'a', service: true}

    it('restarts on the new code though the versions match', () => {
        expect(launcherMove({...same, now: 'b', busy: 0})).toBe('restart')
        expect(launcherMove({...same, now: 'b', busy: 2})).toBe('wait')
    })

    it("doesn't restart when it can't tell what code it started on", () => {
        expect(launcherMove({...same, code: undefined, now: 'b', busy: 0})).toBeNull()
    })

    it('reads the same code from an unchanged checkout', () => {
        expect(CODE).toMatch(/^[0-9a-f]{16}$/)
        expect(codeOnDisk()).toBe(CODE)
    })
})

describe('a launcher the bootstrap ran, and what an orrery serves', () => {
    const url = 'http://localhost:9000'
    const mine = {url, from: url, mine: '1.0.0-rc.13', code: 'a'}

    it('restarts for a newer version anywhere on its list', () => {
        expect(servedOtherCode({...mine, from: 'http://localhost:9020', served: {version: '1.0.0-rc.14', code: 'b'}})).toBe(true)
    })

    it('restarts for other code from the orrery it came from, even an older version', () => {
        expect(servedOtherCode({...mine, served: {version: '1.0.0-rc.13', code: 'b'}})).toBe(true)
        expect(servedOtherCode({...mine, served: {version: '1.0.0-rc.12', code: 'b'}})).toBe(true)
    })

    it('stays for other code at another orrery of its version or older, or it would restart for ever', () => {
        expect(servedOtherCode({...mine, from: 'http://localhost:9020', served: {version: '1.0.0-rc.13', code: 'b'}})).toBe(false)
        expect(servedOtherCode({...mine, from: 'http://localhost:9020', served: {version: '1.0.0-rc.12', code: 'b'}})).toBe(false)
    })

    it('stays for the code it has, an orrery with none to serve, or one the bootstrap won\'t fetch from', () => {
        expect(servedOtherCode({...mine, served: {version: '1.0.0-rc.13', code: 'a'}})).toBe(false)
        expect(servedOtherCode({...mine, served: null})).toBe(false)
        expect(servedOtherCode({...mine, url: 'http://192.168.1.5:9000', served: {version: '1.0.0-rc.14', code: 'b'}})).toBe(false)
    })
})
