import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {launcherMove, VERSION} from '../../channel/version.mjs'

const behind = {theirs: ['1.0.0-rc.11'], mine: '1.0.0-rc.10', service: true}

describe("a launcher on other code than its orrery's", () => {
    it('restarts once its checkout holds new code and no session of its own is running', () => {
        expect(launcherMove({...behind, disk: '1.0.0-rc.11', running: 0})).toBe('restart')
    })

    it('waits while it runs a session', () => {
        expect(launcherMove({...behind, disk: '1.0.0-rc.11', running: 1})).toBe('wait')
    })

    it('says to update the checkout while that still holds the code it runs, rather than restarting on it again', () => {
        expect(launcherMove({...behind, disk: '1.0.0-rc.10', running: 0})).toBe('tell')
        expect(launcherMove({...behind, disk: undefined, running: 0})).toBe('tell')
    })

    it('does nothing in a terminal, or when every orrery it serves runs its code', () => {
        expect(launcherMove({...behind, disk: '1.0.0-rc.11', running: 0, service: false})).toBeNull()
        expect(launcherMove({...behind, theirs: ['1.0.0-rc.10', '1.0.0-rc.10'], disk: '1.0.0-rc.11', running: 0})).toBeNull()
    })

    it("knows its own version, from the checkout's web/package.json", async () => {
        const {version} = (await import('../package.json')).default
        expect(VERSION).toBe(version)
    })
})
