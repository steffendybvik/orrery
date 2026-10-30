// What a Claude session in an app's repo needs to keep that app's roadmap in orrery: the brief (served
// at /connect/<project>.md and shown on the Connect page) and the pieces it sets up. Built in one
// place, so the page and the URL say the same. A project's name and a session's come from the URL, so
// nothing in them reaches a shell command unquoted or adds a line to the brief.
import {keyFor, slugify} from './roadmap'

export interface ConnectTarget {
    /** Where orrery runs, as the agent should reach it. */
    origin: string
    /** Where the orrery repo is on the machine (for the channel and hook scripts). */
    id: string
    name: string
    key: string
    /** The project doesn't exist yet: the brief has the agent create it. */
    isNew: boolean
    /** ORRERY_SESSION for the window, to tell windows apart. */
    session?: string
    /** This orrery: its id (ORRERY_ID, which the channel checks) and environment, which names the channel's
     * server, one per orrery for all of a repo's projects. Without it, the server is named after the project. */
    orrery?: {id: string, environment: string}
}

export interface ConnectPieces {
    bootstrap: string
    brief: string
    claudeMd: string
    mcpJson: string
    settingsJson: string
    /** The channel's server name in .mcp.json, which the launch line loads: `orrery-<environment>`. */
    server: string
    launch: string
    monitor: string
    /** The one line to give an agent: read the brief at its URL and follow it. */
    prompt: string
    url: string
}

// PreToolUse runs on every tool call, so it runs in the background (`async`): it catches the turns
// no prompt started (a focus signal, a background task finishing). StopFailure runs instead of Stop when a turn
// ends on an API error, which lets go of what the session had in progress.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'SessionEnd']
/** The ones that run in the background: Claude Code doesn't wait on them, so they never hold up a tool or answer its prompt. */
const ASYNC_EVENTS = ['PreToolUse', 'PermissionRequest']

/** Puts the bootstrap on this machine: it stays the same across versions, and runs what the orrery at `origin` serves. */
export const bootstrapInstall = (origin: string) => `mkdir -p ~/.orrery && curl -fsS ${origin}/channel/bootstrap.mjs -o ~/.orrery/bootstrap.mjs`
/** Puts the bootstrap on this machine, and the launcher service with it. */
export const launcherInstall = (origin: string) => `${bootstrapInstall(origin)} && ORRERY_URL=${origin} node ~/.orrery/bootstrap.mjs launcher --install`

export function connectPieces(target: ConnectTarget): ConnectPieces {
    const {origin, id, key, isNew} = target
    const name = target.name.replace(/\s+/g, ' ').trim()
    const session = sessionName(target.session ?? '') || undefined
    const server = target.orrery ? serverName(target.orrery.environment) : id

    const mcpJson = JSON.stringify({
        mcpServers: {[server]: {command: 'node', args: ['${HOME}/.orrery/bootstrap.mjs', 'channel'], env: {
            ORRERY_URL: origin, ...target.orrery ? {ORRERY_ID: target.orrery.id} : {}, ORRERY_PROJECTS: id,
            // From the user's environment: this file is committed, so a name in it would make every clone that person.
            ORRERY_PERSON: '${ORRERY_PERSON:-}',
        }}},
    }, null, 2)
    const command = `ORRERY_PROJECT=${id} ORRERY_URL=${origin}${target.orrery ? ` ORRERY_ID=${target.orrery.id}` : ''} node "$HOME/.orrery/bootstrap.mjs" hook`
    const hook = (event: string) => [{hooks: [{type: 'command', command, timeout: 5, ...ASYNC_EVENTS.includes(event) ? {async: true} : {}}]}]
    const settingsJson = JSON.stringify({hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, hook(event)]))}, null, 2)
    const launch = `${session ? `ORRERY_SESSION=${session} ` : ''}claude --dangerously-load-development-channels server:${server}`
    const monitor = `Use the Monitor tool to watch this command, and whenever a line asks you to focus on an issue, work on that issue:
curl -sN '${origin}/api/projects/${id}/signals/stream?format=text'`

    const claudeMd = `## Roadmap

The roadmap is in orrery (${origin}), project \`${id}\`, issue ids \`${key}-n\`. How to use it: \`curl -s ${origin}/llms-full.txt\`.

- Work from an issue: set it to \`in-progress\` (assignee \`claude\`) before starting, comment as it moves, \`done\` when it ships (\`canceled\` when it's dropped).
- Knowledge (decisions, how things work) goes in the project's docs.
- Send \`Orrery-Actor: claude\` on every write. orrery hands out ids; don't send one.
- With orrery's server in \`.mcp.json\`, its tools (\`issue\`, \`start_issue\`, \`comment\`, \`finish_issue\`, …) do all of this without curl.`

    const brief = `# Connect ${name} to orrery

You're working in the ${name} repo. Its roadmap lives in orrery at ${origin}, as project \`${id}\` (issue ids \`${key}-1\`, \`${key}-2\`, …). orrery is the source of truth: don't keep the roadmap in a file here.

First read how to use it:

    curl -s ${origin}/llms-full.txt
${isNew ? `
The project doesn't exist yet. Create it:

    curl -s -X POST ${origin}/api/projects -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' -d ${shellQuote(JSON.stringify({name, id, key}))}
` : ''}
## While you work

- Before a piece of work, find its issue (\`${origin}/api/projects/${id}/issues?q=…\`) or create one; set it to \`in-progress\` and assign it to \`claude\`.
- Comment on it as the work moves, and set it to \`done\` when it ships.
- Keep decisions and how-things-work notes in the project's docs (\`PUT ${origin}/api/projects/${id}/docs/<slug>\`).
- Send the header \`Orrery-Actor: claude\` on every write.
- Write JSON bodies from a file or a quoted heredoc, so backticks in Markdown survive the shell.

## Set this repo up

Merge with what's already in each file.

0. Put orrery's bootstrap on this machine, which runs the channel and hooks as this orrery serves them, so they upgrade with it:

    ${bootstrapInstall(origin)}

1. Add this section to \`CLAUDE.md\`:

${claudeMd.split('\n').map(line => line ? `    ${line}` : '').join('\n')}

2. Register orrery's channel in \`.mcp.json\`, so orrery can ask this session to focus on an issue:

${mcpJson.split('\n').map(line => `    ${line}`).join('\n')}

   One entry serves all of the repo's projects on this orrery: if \`.mcp.json\` already runs orrery's channel for it (\`bootstrap.mjs channel\`, or an older \`orrery-channel.mjs\` from a checkout, which you switch to the command above, and its hooks with it) (the same \`ORRERY_ID\`, or the same \`ORRERY_URL\`), add \`${id}\` to that entry's \`ORRERY_PROJECTS\` (comma-separated, or \`*\` for every project on it) instead, and fold any entry that serves one project (\`ORRERY_PROJECT\`) into it.

3. Add these hooks to \`.claude/settings.json\`, so orrery sees this session's name and whether it's idle, working or needs the owner:

${settingsJson.split('\n').map(line => `    ${line}`).join('\n')}

## Then

Tell the owner what's in progress and what's urgent, and ask them to restart you with this, so the channel and hooks load (Claude Code asks once to approve the ${server} server):

    ${launch}
`

    const query = session ? `?session=${encodeURIComponent(session)}` : isNew ? `?name=${encodeURIComponent(name)}` : ''
    const url = `${origin}/connect/${id}.md${query}`
    const prompt = `Set this repo up for orrery: read ${url} (curl -s '${url}') and follow it.`
    return {brief, bootstrap: bootstrapInstall(origin), claudeMd, mcpJson, settingsJson, server, launch, monitor, prompt, url}
}

/** A name's id and prefix, as orrery would make them (`app` for an id when the name makes none). */
export function idsFor(name: string): {id: string, key: string} {
    return {id: slugify(name) || 'app', key: keyFor(name)}
}

/** A window's name as ORRERY_SESSION takes it: lowercase letters, digits and dashes, safe in a shell. */
function sessionName(text: string): string {
    return slugify(text)
}

/** `text` as one word for a POSIX shell: single-quoted, any `'` closed, escaped and reopened. */
function shellQuote(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`
}

/** The channel's server name for an orrery, as Connect writes it in .mcp.json: `orrery-<environment>` (`Work` →
 * `orrery-work`). channel/server-name.mjs is the same for the channel. */
export function serverName(environment: string): string {
    return `orrery-${slugify(environment) || 'orrery'}`
}
