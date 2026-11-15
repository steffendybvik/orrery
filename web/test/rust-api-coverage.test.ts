// Every route the Nuxt server has, held against what the Rust API serves (ORR-1010). Both servers write one database
// while the domains move (ORR-923), so a route that's neither sent to the API nor listed here as staying would slip
// through unnoticed. A route is either sent on by the router's DOMAINS (server/utils/api-router.ts), or has its own line
// in NOT_ROUTED (route-table.ts, ORR-1037): the issue that moves it, or why it stays with the local app. A new route
// fails here until it's one or the other, and so does a line that no longer matches anything. The replies themselves
// are compared per domain in api-parity.test.ts, and the schema the two make in rust-migrations.test.ts.
import {writeFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {domainOf, DOMAINS, servedByApi} from '../server/utils/api-router'
import {NOT_ROUTED} from './route-table'
import type {Line} from './route-table'
import {contract, methodOf, nuxtRoutes, pathOf, replies, rustRoutes} from './routes'

/** The line of DOMAINS that sends a request on. */
const domainLine = (method: string, path: string) => DOMAINS.find(({paths, methods}) => paths.test(path.slice('/api/'.length)) && (!methods || methods.includes(method)))

/** Every operation either server has, by path and then method, as the table lists them. */
const operations = () => [...new Set([...nuxtRoutes(), ...rustRoutes()])].sort((a, b) => pathOf(a).localeCompare(pathOf(b)) || a.localeCompare(b))
/** Whether the router sends the operation on: the Nuxt route for it is gone, unless its line keeps some here (ORR-1041). */
const routed = (route: string) => operations().includes(route) && servedByApi(methodOf(route), pathOf(route))

describe('every Nuxt route, against the Rust API', () => {
    it('is sent to the API, or has a line in the table with the issue that moves it or why it stays', () => {
        expect(nuxtRoutes().filter(route => !routed(route) && !NOT_ROUTED[route]), 'routes neither DOMAINS sends on nor NOT_ROUTED lists').toEqual([])
    })

    it('has no line when the router sends it on', () => {
        expect(nuxtRoutes().filter(route => routed(route) && NOT_ROUTED[route]), 'routes NOT_ROUTED lists that DOMAINS sends on').toEqual([])
    })

    it('leaves no line that matches nothing, or names neither an issue nor a reason', () => {
        const all = operations()
        expect(Object.keys(NOT_ROUTED).filter(route => !all.includes(route)), 'stale NOT_ROUTED lines').toEqual([])
        for (const [route, line] of Object.entries(NOT_ROUTED)) {
            expect('issue' in line ? /^ORR-\d+$/.test(line.issue) && line.gap.length > 0 : ('stays' in line ? line.stays : line.rustOnly).length > 0, route).toBe(true)
        }
    })

    it('says only of what Nuxt lacks that the Rust API has it alone, and of nothing Nuxt has', () => {
        const nuxt = nuxtRoutes()
        expect(operations().filter(route => !nuxt.includes(route) && !routed(route) && !(NOT_ROUTED[route] && 'rustOnly' in NOT_ROUTED[route])), 'Rust-only routes without a rustOnly line').toEqual([])
        expect(nuxt.filter(route => NOT_ROUTED[route] && 'rustOnly' in NOT_ROUTED[route]), 'Nuxt routes marked Rust-only').toEqual([])
    })

    it('has every route the router sends on served by the Rust API, so none is answered 404 or 405', () => {
        const rust = rustRoutes()
        expect(operations().filter(routed).filter(route => !rust.includes(route)), 'routed routes router() lacks').toEqual([])
    })

    it("has no Nuxt route left for what it sends on, but for a line that keeps some of its requests here (ORR-1041)", () => {
        const kept = (route: string) => domainLine(methodOf(route), pathOf(route))?.here
        expect(nuxtRoutes().filter(route => routed(route) && !kept(route)), 'Nuxt routes the Rust API serves alone').toEqual([])
        expect(DOMAINS.filter(line => line.here && !nuxtRoutes().some(route => routed(route) && domainLine(methodOf(route), pathOf(route)) === line)).map(d => d.domain), 'lines with here and no route here').toEqual([])
    })

    it('leaves no line of DOMAINS that sends nothing on', () => {
        const all = operations()
        expect(DOMAINS.filter(({paths, methods}) => !all.some(route => paths.test(pathOf(route).slice('/api/'.length)) && (!methods || methods.includes(methodOf(route))))).map(d => d.domain)).toEqual([])
    })
})

describe("the Rust API's router()", () => {
    it('serves the contract, the routes written ahead of it, and nothing more', () => {
        const rustOnly = Object.entries(NOT_ROUTED).filter(([route, line]) => 'rustOnly' in line && !contract(true).includes(route)).map(([route]) => route)
        expect(rustRoutes()).toEqual([...contract(), ...contract(true), ...rustOnly].sort())
    })

    it('has the replies of each operation in the contract, at least one of them a success or a redirect', () => {
        const given = replies()
        expect([...contract(), ...contract(true)].filter(route => !given[route]?.some(status => /^[23]/.test(status))), 'operations with no success or redirect').toEqual([])
    })
})

/** The table for the `rust-api-parity` doc: every operation, a line each. */
function table(): string {
    const rust = rustRoutes()
    const nuxt = nuxtRoutes()
    const ahead = contract(true)
    const given = replies()
    const why = (line: Line | undefined) => !line ? '' : 'issue' in line ? `**gap**: ${line.gap} ([${line.issue}](/p/orrery/issues/${line.issue}))` : 'stays' in line ? `stays: ${line.stays}` : `Rust only: ${line.rustOnly}`
    const rows = operations().map(route => {
        const served = rust.includes(route) ? routed(route) ? `yes, as ${domainOf(methodOf(route), pathOf(route))}` : ahead.includes(route) ? 'served, not routed (written ahead)' : 'served, not in the contract' : 'no'
        const parity = rust.includes(route) && [...contract(), ...ahead].includes(route) ? 'driven' : ''
        return `| \`${route}\` | ${nuxt.includes(route) ? 'yes' : 'no'} | ${served} | ${parity} | ${(given[route] ?? []).join(', ')} | ${why(NOT_ROUTED[route]).replaceAll('|', '\\|')} |`
    })
    return ['| Operation | Nuxt | Rust API | Parity test | Replies | Gap, or why it stays |', '|---|---|---|---|---|---|', ...rows].join('\n') + '\n'
}

describe.skipIf(!process.env.ROUTE_TABLE)('the table', () => {
    it('is written out for the doc', () => writeFileSync(process.env.ROUTE_TABLE!, table()))
})
