// Every route the Nuxt server has, held against what the Rust API serves (ORR-1010). Both servers write one database
// while the domains move (ORR-923), so a route that's neither sent to the API nor listed here as staying would slip
// through unnoticed. A route is either sent on by the router's DOMAINS (server/utils/api-router.ts), or has a line in
// UNROUTED: the issue that moves it, or why it stays with the local app. A new route fails here until it's one or the
// other, and so does a line that no longer matches anything. The replies themselves are compared per domain in
// api-parity.test.ts, and the schema the two make in rust-migrations.test.ts.
import {describe, expect, it} from 'vitest'
import {DOMAINS, servedByApi} from '../server/utils/api-router'
import {contract, methodOf, nuxtRoutes, pathOf, rustRoutes} from './routes'

type Line = {routes: RegExp} & ({issue: `ORR-${number}`} | {stays: string})

/** The Nuxt server's routes the router keeps, a line per reason: matched against `METHOD /api/path`, `{param}`s as they are. */
const UNROUTED: readonly Line[] = [
    // Gaps: what a domain the API has taken over still does here, until its issue moves it.
    {routes: /^(POST \/api\/projects\/\{project\}\/issues|PATCH \/api\/projects\/\{project\}\/issues|DELETE \/api\/projects\/\{project\}\/issues|POST \/api\/projects\/\{project\}\/issues\/decide)$/, issue: 'ORR-927'},
    {routes: /^(POST \/api\/projects\/\{project\}\/issues\/\{issue\}\/(decide|focus|schedule-requests(\/\{comment\})?)|GET \/api\/projects\/\{project\}\/issues\/\{issue\}\/(branches|pulls)|POST \/api\/uploads)$/, issue: 'ORR-927'},
    {routes: /^(GET|POST|PUT|DELETE) \/api\/(auth\/(link|status)|owner|permissions|projects\/\{project\}\/members(\/\{person\})?)$/, issue: 'ORR-928'},
    {routes: /^(GET|DELETE) \/api\/projects\/\{project\}$|^\w+ \/api\/projects\/(\{project\}\/(export|import)|upload)$/, issue: 'ORR-1006'},
    {routes: /^(POST|PATCH|DELETE) \/api\/(projects\/\{project\}\/schedules(\/\{schedule\}(\/(adopt|run))?|\/enabled)?|schedules(\/across\/\{across\})?)$/, issue: 'ORR-950'},
    // What stays with the local app: the machine, its sessions and launcher, and what only it can do.
    {routes: /^POST \/api\/(epics\/\{epic\}|projects\/\{project\}\/milestones\/\{milestone\})\/focus$/, stays: "a focus signals the sessions, which are the machine's (ORR-1004)"},
    {routes: /^(GET|POST|PATCH|DELETE) \/api\/chats(\/\{chat\}(\/(clear|end|messages|replies|requests(\/\{message\})?))?)?$/, stays: "the chat's sessions are the local app's; the API keeps their rows, through PUT /api/chats/{chat}"},
    {routes: /^POST \/api\/auth\/(login|logout)$|^GET \/api\/auth\/oidc\/(start|callback)$/, stays: 'logging in and out is checked here (auth.ts); the API hears what that found'},
    {routes: /^(PUT|PATCH|DELETE) \/api\/secrets\/\{name\}$|^POST \/api\/egress$/, stays: "sealed with the machine's key (decision-rust-api-secrets-settings)"},
    {routes: /^(GET|POST|DELETE) \/api\/pulls(\/(poll|branches))?$/, stays: 'asks GitHub, which is the local app\'s to do (ORR-952)'},
    {routes: /^GET \/api\/projects\/\{project\}\/docs\/\{doc\}\/artifact$/, stays: "drawn with the page's own sanitising and its locked-down headers"},
    {routes: /^\w+ \/api\/(projects\/\{project\}\/)?(sessions|launches|signals|listeners|context)(\/.*)?$|^\w+ \/api\/signals\/stream$/, stays: 'the sessions, the launcher and their signals are the machine\'s'},
    {routes: /^\w+ \/api\/(backups|database|connects|events|usage|phone)(\/.*)?$|^GET \/api\/(machine|mcp|version|guide(\/using)?)$/, stays: "the machine's: its files, the event log, its own use, and what it says about itself"},
]

/** What the Rust API serves that no Nuxt route is, besides the contract's routes written ahead of it. */
const RUST_ONLY = ['GET /api/changes', 'GET /health']

const routed = (route: string) => servedByApi(methodOf(route), pathOf(route))
const linesOf = (route: string) => UNROUTED.filter(line => line.routes.test(route))

describe('every Nuxt route, against the Rust API', () => {
    it('is sent to the API, or listed with the issue that moves it or why it stays', () => {
        const nobodys = nuxtRoutes().filter(route => !routed(route) && !linesOf(route).length)
        expect(nobodys, 'routes neither DOMAINS sends on nor UNROUTED lists').toEqual([])
    })

    it('is listed once at most, and never when the router sends it on', () => {
        expect(nuxtRoutes().filter(route => linesOf(route).length > 1), 'routes on more than one UNROUTED line').toEqual([])
        expect(nuxtRoutes().filter(route => routed(route) && linesOf(route).length), 'routes UNROUTED lists that DOMAINS sends on').toEqual([])
    })

    it('leaves no line that matches nothing, or names neither an issue nor a reason', () => {
        const unrouted = nuxtRoutes().filter(route => !routed(route))
        expect(UNROUTED.filter(line => !unrouted.some(route => line.routes.test(route))).map(line => String(line.routes)), 'stale UNROUTED lines').toEqual([])
        for (const line of UNROUTED) expect('issue' in line ? /^ORR-\d+$/.test(line.issue) : line.stays.length > 0, String(line.routes)).toBe(true)
    })

    it('has every route the router sends on served by the Rust API, so none is answered 404 or 405', () => {
        const rust = rustRoutes()
        expect(nuxtRoutes().filter(routed).filter(route => !rust.includes(route)), 'routed routes router() lacks').toEqual([])
    })

    it('leaves no line of DOMAINS that sends nothing on', () => {
        const nuxt = nuxtRoutes()
        expect(DOMAINS.filter(({paths, methods}) => !nuxt.some(route => paths.test(pathOf(route).slice('/api/'.length)) && (!methods || methods.includes(methodOf(route))))).map(d => d.domain)).toEqual([])
    })
})

describe("the Rust API's router()", () => {
    it('serves the contract, the routes written ahead of it, and nothing more', () => {
        expect(rustRoutes()).toEqual([...contract(), ...contract(true), ...RUST_ONLY].sort())
    })
})
