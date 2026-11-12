// orrery's own MCP server at `/mcp`, beside the channel (ORR-1102): a session the launcher starts on an orrery that
// serves it gets an `http` entry for it, and its channel lists only its own tools (`ORRERY_TOOLS=local`,
// `CHANNELS_OWN` in tools.mjs), so each tool is listed once. On an orrery that doesn't serve `/mcp` (an older one, or
// one with no Rust API running), the channel keeps every tool, as before.
import {randomUUID} from 'node:crypto'

/** How long a probe of `/mcp` waits for an answer. */
const PROBE_FOR = 3000

/** Whether the orrery at `url` serves `/mcp`: it answers MCP's `initialize` with a protocol version. */
export async function servesMcp(url, {headers = {}, fetch = globalThis.fetch} = {}) {
    try {
        const response = await fetch(`${url}/mcp`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
            body: JSON.stringify({jsonrpc: '2.0', id: 0, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'orrery-launcher', version: '1'}}}),
            signal: AbortSignal.timeout(PROBE_FOR),
        })
        if (!response.ok) return false
        const answer = await response.json()
        return typeof answer?.result?.protocolVersion === 'string'
    } catch {
        return false
    }
}

/** The name `/mcp`'s entry goes by beside the channel's `server`, so its tools are `mcp__<server>-api__…`. */
export const besideName = server => `${server}-api`

/** The `http` entry for a launch's session (`--mcp-config`), and the Claude session id it's for: the one a chat is taken
 * up again on (`resume`), else a new one the session is started with (`--session-id`), so `/mcp` hears which session
 * calls, as the channel says it (`Orrery-Session`). It carries who's calling as the channel's tools do: `claude`, for
 * `person`, with the machine's `auth`, and an untrusted session or a chat saying so. */
export function besideFor({url, server, launch, person, auth = {}, resume, id = randomUUID()}) {
    const session = resume ?? id
    const headers = {'Orrery-Actor': 'claude', 'Orrery-Session': session, ...person ? {'Orrery-Person': person} : {}, ...auth,
        ...launch.untrusted ? {'Orrery-Untrusted': 'yes'} : {}, ...launch.chat ? {'Orrery-Chat': 'yes', 'Orrery-Launch': launch.id} : {}}
    const name = besideName(server)
    return {name, session, fresh: !resume, config: {mcpServers: {[name]: {type: 'http', url: `${url}/mcp`, headers}}}}
}
