// What Orrery tells an agent about itself: /llms.txt (an overview and the projects), /llms-full.txt
// (that plus the API reference) and /api/guide (the reference alone, docs/API.md).
import type {H3Event} from 'h3'

export async function apiReference(): Promise<string> {
    return String(await useStorage('assets:docs').getItem('API.md') ?? '')
}

/** The address Orrery was reached at, as the agent reading this should use it. */
export function originOf(event: H3Event): string {
    return getRequestURL(event).origin
}

export function overview(event: H3Event): string {
    const origin = originOf(event)
    const projects = useStore().listProjects()
    return `# Orrery

> A local roadmap board for your projects and the Claude Code sessions working on them. Each app's roadmap (chunks of work, issues with
> sub-issues, comments, docs) lives here, kept current by the Claude sessions working in the app's repo
> through a JSON API. The page at ${origin} shows it read-only and updates live.

Use it like this: before a piece of work, create (or pick) its issue and set it to \`doing\`, assigned
to yourself; comment as it moves; set it to \`done\` when it ships. Keep knowledge (decisions, how
things work) in the project's docs. Name yourself on every write with the header \`Orrery-Actor: claude\`.
Ids are handed out by Orrery: issues are the project's prefix and a number (\`MSH-142\`), chunks a number.
When you need the owner to decide something or give feedback, ask in a comment on the issue with
\`"asks": "decision"\` (or \`"feedback"\`): it waits at the top of their bell until they answer.

## Docs

- [API reference](${origin}/api/guide): every route, field and rule
- [Everything in one file](${origin}/llms-full.txt): this overview and the API reference

## Projects

${projects.map(p => `- ${p.name}: id \`${p.id}\`, prefix \`${p.key}\`, ${p.counts.done}/${Object.values(p.counts).reduce((a, b) => a + b, 0)} done (${origin}/api/projects/${p.id})`).join('\n') || '- none yet: create one with POST /api/projects'}
`
}
