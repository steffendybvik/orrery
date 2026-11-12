// The Rust API's copy of the channel's tool lists (ORR-1098, api/mcp-tools.json): what `/mcp` lists to a work session,
// the chat and an untrusted session (api/src/mcp/tools.rs), as channel/tools.mjs has them, and the chat's request
// actions `request_fields` describes. The lists are still written
// in channel/tools.mjs. Then, to port a change:
//
//   ORRERY_WRITE_MCP_TOOLS=1 pnpm --dir web exec vitest run --project unit test/rust-mcp-tools.test.ts
//
// which writes api/mcp-tools.json, and api/mcp-tools-checks.json: what `toolsFor` gives for a few cases, which the
// Rust tests hold `tools_for` to. The test fails until both match.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {CHAT_REQUESTS, ON_DEMAND, SCOPED, toolsFor} from '../../channel/tools.mjs'

const FILE = fileURLToPath(new URL('../../api/mcp-tools.json', import.meta.url))
const CHECKS = fileURLToPath(new URL('../../api/mcp-tools-checks.json', import.meta.url))
const ONE = ['one']
const groups = Object.keys(ON_DEMAND)

/** The lists for one project, before `tools_for` adds `project` for several: a work session's with every group loaded. */
function expected(): string {
    const work = toolsFor(ONE, {loaded: groups})
    const moreTools = toolsFor(ONE).find(t => t.name === 'more_tools')
    return `${JSON.stringify({
        work,
        chat: toolsFor(ONE, {chat: true}),
        untrusted: toolsFor(ONE, {untrusted: true}),
        more_tools: moreTools,
        on_demand: ON_DEMAND,
        scoped: SCOPED,
        chat_requests: CHAT_REQUESTS,
    }, null, 1)}\n`
}

/** What `toolsFor` gives, for the Rust tests to compare with. */
function checks(): string {
    const two = ['alpha', 'beta']
    const cases = [
        {name: 'work, one project', projects: ONE, kind: 'work', loaded: []},
        {name: 'work, two projects', projects: two, kind: 'work', loaded: []},
        {name: 'work, two projects, secrets loaded', projects: two, kind: 'work', loaded: ['secrets']},
        {name: 'work, every group loaded', projects: two, kind: 'work', loaded: groups},
        {name: 'chat, two projects', projects: two, kind: 'chat', loaded: []},
        {name: 'untrusted, two projects', projects: two, kind: 'untrusted', loaded: []},
    ]
    return `${JSON.stringify(cases.map(c => ({...c, tools: toolsFor(c.projects, {chat: c.kind === 'chat', untrusted: c.kind === 'untrusted', loaded: c.loaded})})), null, 1)}\n`
}

describe("the Rust API's copy of the channel's tool lists", () => {
    it('is channel/tools.mjs as it is now', () => {
        if (process.env.ORRERY_WRITE_MCP_TOOLS === '1') {
            writeFileSync(FILE, expected())
            writeFileSync(CHECKS, checks())
        }
        for (const [file, want] of [[FILE, expected()], [CHECKS, checks()]]) {
            expect(existsSync(file), 'run with ORRERY_WRITE_MCP_TOOLS=1 to write it').toBe(true)
            expect(readFileSync(file, 'utf8'), `${file}: run with ORRERY_WRITE_MCP_TOOLS=1 to write it`).toBe(want)
        }
    })
})
