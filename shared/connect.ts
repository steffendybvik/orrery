// What a Claude session in an app's repo needs to keep that app's roadmap in Orrery: the brief (served
// at /connect/<project>.md and shown on the Connect page) and the pieces it sets up. Built in one
// place, so the page and the URL say the same.

export interface ConnectTarget {
    /** Where Orrery runs, as the agent should reach it. */
    origin: string
    /** Where the Orrery repo is on the machine (for the channel and hook scripts). */
    repoDir: string
    id: string
    name: string
    key: string
    /** The project doesn't exist yet: the brief has the agent create it. */
    isNew: boolean
    /** ORRERY_SESSION for the window, to tell windows apart. */
    session?: string
}

export interface ConnectPieces {
    brief: string
    claudeMd: string
    mcpJson: string
    settingsJson: string
    /** The channel's server name in .mcp.json, which the launch line loads: the project's id. */
    server: string
    launch: string
    monitor: string
    /** The one line to give an agent: read the brief at its URL and follow it. */
    prompt: string
    url: string
}

// PreToolUse runs on every tool call, so it runs in the background (`async`): it catches the turns
// no prompt started (a focus signal, a background task finishing).
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification', 'SessionEnd']

export function connectPieces(target: ConnectTarget): ConnectPieces {
    const {origin, repoDir, id, name, key, isNew} = target
    const session = target.session?.trim().replace(/\s+/g, '-')
    const server = id

    const mcpJson = JSON.stringify({
        mcpServers: {[server]: {command: 'node', args: [`${repoDir}/channel/orrery-channel.mjs`], env: {ORRERY_URL: origin, ORRERY_PROJECT: id}}},
    }, null, 2)
    const command = `ORRERY_PROJECT=${id} ORRERY_URL=${origin} node ${repoDir}/channel/orrery-hook.mjs`
    const hook = (event: string) => [{hooks: [{type: 'command', command, timeout: 5, ...event === 'PreToolUse' ? {async: true} : {}}]}]
    const settingsJson = JSON.stringify({hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, hook(event)]))}, null, 2)
    const launch = `${session ? `ORRERY_SESSION=${session} ` : ''}claude --dangerously-load-development-channels server:${server}`
    const monitor = `Use the Monitor tool to watch this command, and whenever a line asks you to focus on an issue, work on that issue:
curl -sN '${origin}/api/projects/${id}/signals/stream?format=text'`

    const claudeMd = `## Roadmap

The roadmap is in Orrery (${origin}), project \`${id}\`, issue ids \`${key}-n\`. How to use it: \`curl -s ${origin}/llms-full.txt\`.

- Work from an issue: set it to \`in-progress\` (assignee \`claude\`) before starting, comment as it moves, \`done\` when it ships (\`canceled\` when it's dropped).
- Knowledge (decisions, how things work) goes in the project's docs.
- Send \`Orrery-Actor: claude\` on every write. Orrery hands out ids; don't send one.`

    const brief = `# Connect ${name} to Orrery

You're working in the ${name} repo. Its roadmap lives in Orrery at ${origin}, as project \`${id}\` (issue ids \`${key}-1\`, \`${key}-2\`, …). Orrery is the source of truth: don't keep the roadmap in a file here.

First read how to use it:

    curl -s ${origin}/llms-full.txt
${isNew ? `
The project doesn't exist yet. Create it:

    curl -s -X POST ${origin}/api/projects -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' -d '{"name": "${name}", "id": "${id}", "key": "${key}"}'
` : ''}
## While you work

- Before a piece of work, find its issue (\`${origin}/api/projects/${id}/issues?q=…\`) or create one; set it to \`in-progress\` and assign it to \`claude\`.
- Comment on it as the work moves, and set it to \`done\` when it ships.
- Keep decisions and how-things-work notes in the project's docs (\`PUT ${origin}/api/projects/${id}/docs/<slug>\`).
- Send the header \`Orrery-Actor: claude\` on every write.
- Write JSON bodies from a file or a quoted heredoc, so backticks in Markdown survive the shell.

## Set this repo up

Merge with what's already in each file.

1. Add this section to \`CLAUDE.md\`:

${claudeMd.split('\n').map(line => line ? `    ${line}` : '').join('\n')}

2. Register Orrery's channel, named after the project, in \`.mcp.json\`, so Orrery can ask this session to focus on an issue:

${mcpJson.split('\n').map(line => `    ${line}`).join('\n')}

3. Add these hooks to \`.claude/settings.json\`, so Orrery sees this session's name and whether it's idle, working or needs the owner:

${settingsJson.split('\n').map(line => `    ${line}`).join('\n')}

## Then

Tell the owner what's in progress and what's urgent, and ask them to restart you with this, so the channel and hooks load (Claude Code asks once to approve the ${server} server):

    ${launch}
`

    const query = session ? `?session=${encodeURIComponent(session)}` : isNew ? `?name=${encodeURIComponent(name)}` : ''
    const url = `${origin}/connect/${id}.md${query}`
    const prompt = `Set this repo up for Orrery: read ${url} (curl -s '${url}') and follow it.`
    return {brief, claudeMd, mcpJson, settingsJson, server, launch, monitor, prompt, url}
}

/** A name's id and prefix, as Orrery would make them. */
export function idsFor(name: string): {id: string, key: string} {
    return {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app',
        key: name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 3) || 'APP',
    }
}
