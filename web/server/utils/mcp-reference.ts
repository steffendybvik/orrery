// The MCP server tab on Connect (ORR-772), built from the channel's own lists (`toolsFor`, `CHAT_REQUESTS`, `ON_DEMAND`), so
// it says what a session is really given.
import {CHAT_REQUESTS, ON_DEMAND, toolsFor} from '#channel/tools.mjs'
import type {McpGroup, McpReference, McpTool} from '#shared/mcp'
import {MCP_ENV, MCP_GROUPS} from '#shared/mcp'

interface Listed { name: string, description: string }
const PROJECTS = ['project']
const names = (tools: unknown) => new Set((tools as Listed[]).map(tool => tool.name))
/** A tool's description up to its first full stop: its one line. */
const oneLine = (text: string) => /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text

export function mcpReference(): McpReference {
    const groups = Object.entries(ON_DEMAND as Record<string, string[]>)
    const work = names(toolsFor(PROJECTS))
    const chat = names(toolsFor(PROJECTS, {chat: true}))
    const untrusted = names(toolsFor(PROJECTS, {untrusted: true}))
    const every = new Map<string, Listed>()
    const kinds: Parameters<typeof toolsFor>[1][] = [{loaded: groups.map(([group]) => group) as never[]}, {}, {chat: true}, {untrusted: true}]
    for (const options of kinds) {
        for (const tool of toolsFor(PROJECTS, options) as Listed[]) if (!every.has(tool.name)) every.set(tool.name, tool)
    }
    const row = ({name, description}: Listed): McpTool => ({
        name,
        description: oneLine(description),
        work: work.has(name) || (groups.find(([, tools]) => tools.includes(name))?.[0] ?? false),
        chat: chat.has(name),
        untrusted: untrusted.has(name),
    })
    const placed = new Set(MCP_GROUPS.flatMap(group => group.tools))
    const shown: McpGroup[] = MCP_GROUPS.map(({title, tools}) => ({title, tools: tools.flatMap(name => {
        const tool = every.get(name)
        return tool ? [row(tool)] : []
    })}))
    const other = [...every.values()].filter(tool => !placed.has(tool.name)).map(row)
    return {
        groups: [...shown, ...other.length ? [{title: 'Other', tools: other}] : []].filter(group => group.tools.length),
        requests: (CHAT_REQUESTS as Listed[]).map(({name, description}) => ({name, description: oneLine(description)})),
        env: MCP_ENV,
    }
}
