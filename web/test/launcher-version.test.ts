import {describe, expect, it} from 'vitest'

import {CODE, codeOnDisk, launcherMove, VERSION} from '../../channel/version.mjs'

const behind = {theirs: ['1.0.0-rc.11'], mine: '1.0.0-rc.10', code: 'a', service: true}

describe("a launcher on other code than its orrery's", () => {
    it('restarts once its checkout holds new code and no session of its own is running', () => {
        expect(launcherMove({...behind, now: 'b', running: 0})).toBe('restart')
    })

    it('waits while it runs a session', () => {
        expect(launcherMove({...behind, now: 'b', running: 1})).toBe('wait')
    })

    it('says to update the checkout while that still holds the code it runs, rather than restarting on it again', () => {
        expect(launcherMove({...behind, now: 'a', running: 0})).toBe('tell')
        expect(launcherMove({...behind, now: undefined, running: 0})).toBe('tell')
    })

    it('does nothing in a terminal, or when every orrery it serves runs its code and its checkout holds it', () => {
        expect(launcherMove({...behind, now: 'b', running: 0, service: false})).toBeNull()
        expect(launcherMove({...behind, theirs: ['1.0.0-rc.10', '1.0.0-rc.10'], now: 'a', running: 0})).toBeNull()
    })

    it("knows its own version, from the checkout's web/package.json", async () => {
        const {version} = (await import('../package.json')).default
        expect(VERSION).toBe(version)
    })
})

describe('a launcher whose checkout moves on within a version (ORR-470)', () => {
    const same = {theirs: ['1.0.0-rc.10'], mine: '1.0.0-rc.10', code: 'a', service: true}

    it('restarts on the new code once no session of its own is running, though the versions match', () => {
        expect(launcherMove({...same, now: 'b', running: 0})).toBe('restart')
        expect(launcherMove({...same, now: 'b', running: 2})).toBe('wait')
    })

    it("doesn't restart when it can't tell what code it started on", () => {
        expect(launcherMove({...same, code: undefined, now: 'b', running: 0})).toBeNull()
    })

    it('reads the same code from an unchanged checkout', () => {
        expect(CODE).toMatch(/^[0-9a-f]{16}$/)
        expect(codeOnDisk()).toBe(CODE)
    })
})
