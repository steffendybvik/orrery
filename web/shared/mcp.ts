// What the MCP server tab on Connect shows (ORR-772): the channel's tools by what they do and who gets each, what asks the
// owner first, and the environment it reads. The tools come from channel/tools.mjs, so this can't go stale when one
// changes; a test holds the groups and the environment to the channel's code.
export interface McpTool {
    name: string
    description: string
    /** A work session has it from the start, or asks for it with `more_tools` by this group. */
    work: boolean | string
    chat: boolean
    untrusted: boolean
}
export interface McpGroup {
    title: string
    tools: McpTool[]
}
export interface McpRequest {
    name: string
    description: string
}
export interface McpEnv {
    name: string
    description: string
}
export interface McpReference {
    groups: McpGroup[]
    requests: McpRequest[]
    env: McpEnv[]
}

/** The tools by what they do, in the order the tab shows them. A tool in none is listed under Other, and a test fails on it. */
export const MCP_GROUPS: {title: string, tools: string[]}[] = [
    {title: 'Issues', tools: ['issues', 'issue', 'create_issue', 'update_issue', 'edit_issue', 'start_issue', 'finish_issue', 'move_issues', 'delegate_issue', 'comment']},
    {title: 'Roadmap', tools: ['chunks', 'releases']},
    {title: 'Docs', tools: ['docs', 'doc', 'write_doc']},
    {title: 'Sessions and presets', tools: ['sessions', 'presets', 'preset']},
    {title: 'Schedules', tools: ['schedules', 'create_schedule', 'update_schedule']},
    {title: 'Outside services', tools: ['secrets', 'egress', 'github_issues', 'github_pulls']},
    {title: 'The chat', tools: ['reply', 'image', 'request', 'request_fields']},
    {title: 'orrery itself', tools: ['guide', 'events', 'resolve_event', 'more_tools']},
]

/** The environment the channel reads, that a person sets. */
export const MCP_ENV: McpEnv[] = [
    {name: 'ORRERY_URL', description: 'The address of the orrery this session keeps its roadmap on.'},
    {name: 'ORRERY_ID', description: "That orrery's id. The channel refuses another orrery at the address, so a repo set up for one never writes to another."},
    {name: 'ORRERY_PROJECTS', description: 'The projects the repo holds, separated by commas, or * for every project on the orrery.'},
    {name: 'ORRERY_PROJECT', description: 'One project, from an older setup. It works the same.'},
    {name: 'ORRERY_HEAR', description: 'Narrows what one session hears to the projects it names.'},
    {name: 'ORRERY_PERSON', description: 'Whose the session is, on an orrery with more than one person and login off.'},
    {name: 'ORRERY_KEY', description: 'An agent key, on an orrery that asks for a login.'},
]

/** What orrery's own launcher and bootstrap set for themselves: nobody needs to set these, so the tab leaves them out. */
export const MCP_ENV_INTERNAL = ['ORRERY_AFTER', 'ORRERY_BOOTSTRAP', 'ORRERY_CHAT', 'ORRERY_CODE', 'ORRERY_FROM', 'ORRERY_HOME', 'ORRERY_LAUNCHER_RELOADS', 'ORRERY_PERMISSION_MODE', 'ORRERY_SESSION', 'ORRERY_STARTED', 'ORRERY_UNTRUSTED', 'ORRERY_VERSION__']
