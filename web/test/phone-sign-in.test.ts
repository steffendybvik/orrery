import {beforeEach, describe, expect, it} from 'vitest'
import {LINK_MINUTES, WRONG_CODES, clearSignInLinks, makeSignInLink, takeSignInCode, takeSignInLink} from '../server/utils/phone-sign-in'

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

    describe('the code to type (ORR-875)', () => {
        it('is six easy-to-read letters, and signs in once, using up the link too', () => {
            const {token, code} = makeSignInLink('skoll')
            expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/)
            expect(takeSignInCode(code)).toBe('skoll')
            expect(takeSignInCode(code)).toBeUndefined()
            expect(takeSignInLink(token)).toBeUndefined()
        })

        it('is used up by the link', () => {
            const {token, code} = makeSignInLink('skoll')
            expect(takeSignInLink(token)).toBe('skoll')
            expect(takeSignInCode(code)).toBeUndefined()
        })

        it('takes it however it is typed: lower case, with a dash or spaces', () => {
            const {code} = makeSignInLink('skoll')
            expect(takeSignInCode(` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `)).toBe('skoll')
        })

        it('runs out with its link', () => {
            const now = Date.now()
            const {code} = makeSignInLink('skoll', now)
            expect(takeSignInCode(code, now + LINK_MINUTES * 60_000)).toBeUndefined()
        })

        it('ends every open code after a few wrong ones in a row, leaving the QR links working', () => {
            const {token, code} = makeSignInLink('skoll')
            const wrongCode = code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'
            for (let i = 0; i < WRONG_CODES; i++) expect(takeSignInCode(wrongCode)).toBeUndefined()
            expect(takeSignInCode(code)).toBeUndefined()
            expect(takeSignInLink(token)).toBe('skoll')
        })

        it('starts the count again after a right one', () => {
            makeSignInLink('skoll')
            const {code} = makeSignInLink('skoll')
            for (let i = 0; i < WRONG_CODES - 1; i++) takeSignInCode('x')
            const next = makeSignInLink('skoll').code
            expect(takeSignInCode(code)).toBe('skoll')
            for (let i = 0; i < WRONG_CODES - 1; i++) takeSignInCode('x')
            expect(takeSignInCode(next)).toBe('skoll')
        })

        it("takes nothing that isn't a code", () => {
            makeSignInLink('skoll')
            for (const code of ['', 'ABC', 'ABCDEFG', undefined, 7, {code: 'x'}]) expect(takeSignInCode(code)).toBeUndefined()
        })
    })
})
