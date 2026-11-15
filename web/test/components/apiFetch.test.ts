import {beforeEach, describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import {getHeader, getQuery} from 'h3'
import {apiFetch, apiUrl, workspaceIn} from '~/utils/api'

// The API client (ORR-666): everything under `/api`, and a write as the owner unless the call says otherwise.
let heard: {actor?: string, workspace?: string, query: unknown} | null = null
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/thing', event => {
    heard = {actor: getHeader(event, 'orrery-actor'), workspace: getHeader(event, 'orrery-workspace'), query: getQuery(event)}
    return {ok: true}
})
beforeEach(() => heard = null)

describe('the API client', () => {
    it('reads under /api, with no actor', async () => {
        expect(await apiFetch('/thing', {query: {a: 1}})).toEqual({ok: true})
        expect(heard).toEqual({actor: undefined, workspace: undefined, query: {a: '1'}})
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

describe('the workspace a page is in (ORR-1108)', () => {
    it('is the one in its address, and none outside /w/', () => {
        expect(workspaceIn('/w/acme/p/rockets')).toBe('acme')
        expect(workspaceIn('/w/side-projects')).toBe('side-projects')
        expect(workspaceIn('/w/caf%C3%A9/p/x')).toBeUndefined()
        expect(workspaceIn('/w/%E0%A4%A')).toBeUndefined()
        expect(workspaceIn('/p/rockets')).toBeUndefined()
        expect(workspaceIn('/w/')).toBeUndefined()
        expect(workspaceIn('/work/acme')).toBeUndefined()
    })

    it('goes with each call from a page under /w/, keeping the actor, unless the call names its own', async () => {
        const from = location.pathname
        history.replaceState(null, '', '/w/acme/p/rockets')
        try {
            await apiFetch('/thing')
            expect(heard?.workspace).toBe('acme')
            await apiFetch('/thing', {method: 'POST', body: {}})
            expect(heard).toMatchObject({workspace: 'acme', actor: 'skoll'})
            await apiFetch('/thing', {headers: {'Orrery-Workspace': 'default'}})
            expect(heard?.workspace).toBe('default')
        } finally {
            history.replaceState(null, '', from)
        }
        await apiFetch('/thing')
        expect(heard?.workspace).toBeUndefined()
    })
})
