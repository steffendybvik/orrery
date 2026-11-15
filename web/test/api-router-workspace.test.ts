import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {servedByApi, workspaceHeader} from '../server/utils/api-router'

// The workspace a page or session names goes on to the API as it came (ORR-1107), which checks it's the asker's.
describe('workspaceHeader', () => {
    it('passes a workspace on, trimmed', () => {
        expect(workspaceHeader(' acme ')).toEqual({'Orrery-Workspace': 'acme'})
    })

    it('sends none for none, an empty one, or one no header could carry', () => {
        expect(workspaceHeader(undefined)).toEqual({})
        expect(workspaceHeader('  ')).toEqual({})
        expect(workspaceHeader('two words')).toEqual({})
        expect(workspaceHeader('x'.repeat(65))).toEqual({})
    })
})

// How each Rust route outside a project is held (api/routes-outside-projects.json, ORR-1222; the cargo test in
// api/src/access/seen_tests.rs holds it to the API's source). `local` is a route only the local app reaches, safe as it
// is because the router never sends a browser's request there, so this holds it to DOMAINS both ways: a new line that
// sends one on has to say how it's held now.
describe('the routes outside a project', () => {
    type Line = {method: string, path: string, held: string}
    const census: Line[] = JSON.parse(readFileSync(new URL('../../api/routes-outside-projects.json', import.meta.url), 'utf8'))
    const routed = ({method, path}: Line) => servedByApi(method, path.replace(/\{[^}]+\}/g, 'x'))
    const api = census.filter(line => line.path.startsWith('/api/'))

    it('are never sent on by the router when they are the local app\'s alone', () => {
        expect(api.filter(line => line.held === 'local' && routed(line)).map(l => `${l.method} ${l.path}`)).toEqual([])
    })

    it('are sent on by the router when they say how a browser\'s request is held', () => {
        expect(api.filter(line => line.held !== 'local' && !routed(line)).map(l => `${l.method} ${l.path}`)).toEqual([])
    })
})
