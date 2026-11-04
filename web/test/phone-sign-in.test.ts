import {beforeEach, describe, expect, it} from 'vitest'
import {LINK_MINUTES, clearSignInLinks, makeSignInLink, takeSignInLink} from '../server/utils/phone-sign-in'

// The one-time sign-in links App settings' QR code carries (ORR-837): each signs a phone in once, for a few minutes.
beforeEach(() => clearSignInLinks())

describe('phone sign-in links', () => {
    it('signs in once, as the person it was made for', () => {
        const {token} = makeSignInLink('skoll')
        expect(takeSignInLink(token)).toBe('skoll')
        expect(takeSignInLink(token)).toBeUndefined()
    })

    it('runs out after a few minutes', () => {
        const now = Date.now()
        const {token, expires_at} = makeSignInLink('skoll', now)
        expect(new Date(expires_at).getTime()).toBe(now + LINK_MINUTES * 60_000)
        expect(takeSignInLink(token, now + LINK_MINUTES * 60_000)).toBeUndefined()
    })

    it("takes nothing that was never made, or isn't a token at all", () => {
        makeSignInLink('skoll')
        expect(takeSignInLink('x'.repeat(32))).toBeUndefined()
        expect(takeSignInLink('')).toBeUndefined()
        expect(takeSignInLink({token: 1})).toBeUndefined()
    })

    it('keeps at most twenty, dropping the oldest', () => {
        const first = makeSignInLink('skoll').token
        for (let i = 0; i < 20; i++) makeSignInLink('skoll')
        expect(takeSignInLink(first)).toBeUndefined()
    })
})
