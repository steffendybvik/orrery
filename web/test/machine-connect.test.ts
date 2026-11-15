import {afterEach, describe, expect, it} from 'vitest'
import {
    CODE_MINUTES, REQUEST_MINUTES, approveConnectRequest, claimConnectRequest, connectRequest, forgetConnects, machineName,
    makeConnectCode, makeConnectRequest, takeConnectCode,
} from '../server/utils/machine-connect'

// Connecting a machine with no key to copy (ORR-1192): the install line's one-time code, and the request a line run
// without one makes, approved on the page and claimed by the launcher with its secret.
afterEach(forgetConnects)

describe('the install line\'s code', () => {
    it('is good once, for its person', () => {
        const {code} = makeConnectCode('ada')
        expect(takeConnectCode(code)).toBe('ada')
        expect(takeConnectCode(code)).toBeUndefined()
    })

    it('runs out, and nothing that isn\'t one is taken', () => {
        const now = Date.now()
        const {code} = makeConnectCode('ada', now)
        expect(takeConnectCode(code, now + CODE_MINUTES * 60_000 + 1)).toBeUndefined()
        for (const wrong of [undefined, null, 42, '', 'oc_short', `${code}x`]) expect(takeConnectCode(wrong)).toBeUndefined()
    })
})

describe('a request to connect', () => {
    it('waits until its person presses Connect, then gives them once, and only with its secret', () => {
        const {request, secret, words} = makeConnectRequest('Ada\'s MacBook')
        expect(words).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
        expect(connectRequest(request)).toMatchObject({name: 'Ada\'s MacBook', words, approved: false})
        expect(claimConnectRequest(request, secret)).toEqual({waiting: true})
        expect(claimConnectRequest(request, 'x'.repeat(32))).toEqual({gone: true})
        expect(approveConnectRequest(request, 'ada')).toBe(true)
        // Someone else can't take it over once it's approved.
        expect(approveConnectRequest(request, 'bo')).toBe(false)
        expect(claimConnectRequest(request, secret)).toEqual({person: 'ada', name: 'Ada\'s MacBook'})
        expect(claimConnectRequest(request, secret)).toEqual({gone: true})
        expect(connectRequest(request)).toBeUndefined()
    })

    it('runs out', () => {
        const now = Date.now()
        const {request, secret} = makeConnectRequest('Rig', now)
        const later = now + REQUEST_MINUTES * 60_000 + 1
        expect(connectRequest(request, later)).toBeUndefined()
        expect(approveConnectRequest(request, 'ada', later)).toBe(false)
        expect(claimConnectRequest(request, secret, later)).toEqual({gone: true})
    })
})

it('names a machine by what it says, trimmed, or "A computer"', () => {
    expect(machineName('  Ada\'s MacBook ')).toBe('Ada\'s MacBook')
    expect(machineName('a\u0007b')).toBe('ab')
    expect(machineName(undefined)).toBe('A computer')
    expect(machineName('x'.repeat(80))).toHaveLength(60)
})
