import type {H3Event} from 'h3'
import {beforeAll, describe, expect, it, vi} from 'vitest'

// The login cookie's name (ORR-956): a browser keeps cookies by host name, not port, so two orrerys on localhost need a
// name each, or logging in to one signs you out of the other.
let loginCookie: (event: H3Event) => string
const asking = (host?: string) => ({headers: host ? {host} : {}}) as unknown as H3Event

beforeAll(async () => {
    vi.stubGlobal('getHeader', (event: {headers: Record<string, string>}, name: string) => event.headers[name])
    ;({loginCookie} = await import('../server/utils/auth'))
})

describe('the login cookie', () => {
    it('is named for the port, so orrerys on one host keep their own logins', () => {
        expect(loginCookie(asking('localhost:9010'))).toBe('orrery_login_9010')
        expect(loginCookie(asking('localhost:9020'))).toBe('orrery_login_9020')
        expect(loginCookie(asking('[::1]:9010'))).toBe('orrery_login_9010')
    })

    it('keeps its old name with no port, as behind a proxy on 443', () => {
        expect(loginCookie(asking('orrery.example'))).toBe('orrery_login')
        expect(loginCookie(asking('[::1]'))).toBe('orrery_login')
        expect(loginCookie(asking())).toBe('orrery_login')
    })
})
