// `GET /api/mcp` → {groups, requests, env}: what the channel's MCP server offers, for the MCP server tab on Connect: its
// tools by what they do and who gets each, what the chat asks the owner first, and the environment it reads.
export default defineEventHandler(() => mcpReference())
