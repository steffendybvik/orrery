import {describe, expect, it} from 'vitest'
import {olderVersion} from '#shared/version'

describe('a version', () => {
    it('is older than a later release, a prerelease before its release, rc.9 before rc.10', () => {
        expect(olderVersion('1.0.0-rc.9', '1.0.0-rc.10')).toBe(true)
        expect(olderVersion('1.0.0-rc.10', '1.0.0')).toBe(true)
        expect(olderVersion('0.9.3', '1.0.0-rc.1')).toBe(true)
        expect(olderVersion('1.0.0', '1.0.1')).toBe(true)
        expect(olderVersion('1.0.0-beta.2', '1.0.0-rc.1')).toBe(true)
    })

    it("isn't older than itself or a version before it", () => {
        expect(olderVersion('1.0.0-rc.10', '1.0.0-rc.10')).toBe(false)
        expect(olderVersion('1.0.0-rc.10', '1.0.0-rc.9')).toBe(false)
        expect(olderVersion('1.0.0', '1.0.0-rc.10')).toBe(false)
        expect(olderVersion('1.1.0', '1.0.9')).toBe(false)
    })

    it('is older when unknown: from code too old to say', () => {
        expect(olderVersion(undefined, '1.0.0-rc.10')).toBe(true)
    })
})
