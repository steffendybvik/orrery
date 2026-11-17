import {readdirSync, readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {underWorkspace} from '../app/router.options'
import {inWorkspace, OUTSIDE_WORKSPACE, pagePath, WORKSPACE_PAGES, workspaceIn} from '../app/utils/api'

// Every page is under its workspace (ORR-1275): `/w/<workspace>/mine`, a project's at `/w/<workspace>/<project>/…`.
describe('pagePath', () => {
    it('drops the workspace a page is under', () => {
        expect(pagePath('/w/acme/mine')).toBe('/mine')
        expect(pagePath('/w/acme')).toBe('/')
        expect(pagePath('/w/acme/settings')).toBe('/settings')
    })

    it("gives a project's page its /p back", () => {
        expect(pagePath('/w/acme/rockets')).toBe('/p/rockets')
        expect(pagePath('/w/acme/rockets/issues/RKT-1')).toBe('/p/rockets/issues/RKT-1')
        expect(pagePath('/w/acme/p/rockets/issues')).toBe('/p/rockets/issues')
    })

    it('leaves a page under none as it is', () => {
        expect(pagePath('/mine')).toBe('/mine')
        expect(pagePath('/')).toBe('/')
        expect(pagePath('/p/rockets')).toBe('/p/rockets')
    })

    it('agrees with workspaceIn on which workspace', () => {
        expect(workspaceIn('/w/acme/mine')).toBe('acme')
        expect(workspaceIn('/mine')).toBeUndefined()
    })
})

describe('inWorkspace', () => {
    it("puts a page under the workspace, a project's without its /p", () => {
        expect(inWorkspace('acme', '/mine')).toBe('/w/acme/mine')
        expect(inWorkspace('acme', '/')).toBe('/w/acme')
        expect(inWorkspace('acme', '/p/rockets')).toBe('/w/acme/rockets')
        expect(inWorkspace('acme', '/p/rockets/issues/RKT-1')).toBe('/w/acme/rockets/issues/RKT-1')
        expect(inWorkspace('a b', '/mine')).toBe('/w/a%20b/mine')
    })

    it('leaves a page outside every workspace, or already under one', () => {
        expect(inWorkspace('acme', '/login')).toBe('/login')
        expect(inWorkspace('acme', '/connect?repo=x')).toBe('/connect?repo=x')
        expect(inWorkspace('acme', '/w/other/mine')).toBe('/w/other/mine')
    })

    it('is undone by pagePath', () => {
        for (const path of ['/mine', '/settings', '/p/rockets', '/p/rockets/docs/x', '/epics/3', '/']) {
            expect(pagePath(inWorkspace('acme', path))).toBe(path)
        }
    })
})

describe('the routes', () => {
    it('are under /w/:workspace, a project\'s without its /p', () => {
        expect(underWorkspace('/')).toBe('/w/:workspace')
        expect(underWorkspace('/mine')).toBe('/w/:workspace/mine')
        expect(underWorkspace('/p/:project()/issues/:issue()')).toBe('/w/:workspace/:project()/issues/:issue()')
        expect(underWorkspace('/login')).toBe('/login')
    })

    it("name every page's first part as a workspace's own, which no project's id can be", () => {
        const pages = readdirSync(new URL('../app/pages', import.meta.url)).map(name => name.replace(/\.vue$/, '')).filter(name => name !== 'index')
        expect(pages.filter(page => !WORKSPACE_PAGES.includes(page))).toEqual([])
        for (const outside of OUTSIDE_WORKSPACE) expect(WORKSPACE_PAGES).toContain(outside.slice(1))
        const rust = readFileSync(new URL('../../api/src/text.rs', import.meta.url), 'utf8')
        const reserved = /RESERVED_PROJECT_IDS: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1]
        expect([...reserved!.matchAll(/"([^"]+)"/g)].map(m => m[1])).toEqual(WORKSPACE_PAGES)
    })
})
