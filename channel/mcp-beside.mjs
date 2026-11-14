// orrery's own MCP server at `/mcp`, beside the channel (ORR-1102): a session the launcher starts gets an `http` entry
// for it, and its channel lists only its own tools (`CHANNELS_OWN` in tools.mjs), so each tool is listed once. The
// board's tools are only at `/mcp` (ORR-1072): on an orrery that doesn't serve it (no Rust API running), the channel
// tells the session so (`servesMcp`, `NO_MCP` in instructions.mjs).
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

/** The `http` entry for a session the launcher starts (`--mcp-config`), and the Claude session id it's started with,
 * so `/mcp` hears which session calls, as the channel says it (`Orrery-Session`): a new one (`--session-id`, `fresh`),
 * or the one a chat is taken up again on (`resume`). It carries who's calling as the channel's tools do: `claude`, for
 * `person`, with the machine's `auth`; and, as the channel says them, the owner's chat (`chat`, its launch's id) or an
 * untrusted schedule's session (`untrusted`), which `/mcp`'s rails hold as the server's guards do. */
export function besideFor({url, server, person, auth = {}, chat, untrusted = false, resume, id = resume ?? randomUUID()}) {
    const headers = {...sessionHeaders({session: id, person, chat, untrusted}), ...auth}
    const name = besideName(server)
    return {name, session: id, fresh: !resume, config: {mcpServers: {[name]: {type: 'http', url: `${url}/mcp`, headers}}}}
}

/** Who's calling `/mcp`, as a session's channel says it on its own calls: `claude`, its Claude session, for `person`, and
 * the owner's chat (`chat`, its launch's id) or an untrusted schedule's session, which `/mcp`'s rails hold as the
 * server's guards do. Not the machine's key, which each adds itself. */
export function sessionHeaders({session, person, chat, untrusted = false}) {
    return {'Orrery-Actor': 'claude', ...session ? {'Orrery-Session': session} : {}, ...person ? {'Orrery-Person': person} : {},
        ...untrusted ? {'Orrery-Untrusted': 'yes'} : {}, ...chat ? {'Orrery-Chat': 'yes', 'Orrery-Launch': chat} : {}}
}
