import {beforeEach, describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, getQuery} from 'h3'
import {apiFetch, apiUrl} from '~/utils/api'

// The API client (ORR-666): everything under `/api`, and a write as the owner unless the call says otherwise.
let heard: {actor?: string, query: unknown} | null = null
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/thing', event => {
    heard = {actor: getHeader(event, 'orrery-actor'), query: getQuery(event)}
    return {ok: true}
})
beforeEach(() => heard = null)

describe('the API client', () => {
    it('reads under /api, with no actor', async () => {
        expect(await apiFetch('/thing', {query: {a: 1}})).toEqual({ok: true})
        expect(heard).toEqual({actor: undefined, query: {a: '1'}})
        expect(apiUrl('/uploads/x')).toBe('/api/uploads/x')
    })

    it('sends a write as the owner, unless the call says otherwise', async () => {
        await apiFetch('/thing', {method: 'POST', body: {}})
        expect(heard?.actor).toBe('skoll')
        await apiFetch('/thing', {method: 'POST', body: {}, headers: {}})
        expect(heard?.actor).toBeUndefined()
        await apiFetch('/thing', {method: 'POST', body: {}, headers: {'Orrery-Actor': 'claude'}})
        expect(heard?.actor).toBe('claude')
    })
})
