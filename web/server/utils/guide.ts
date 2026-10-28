// What orrery tells an agent about itself: /llms.txt (an overview and the projects), /llms-full.txt
// (that plus the API reference) and /api/guide (the reference alone, docs/API.md).
import type {H3Event} from 'h3'
import {total} from '#shared/roadmap'

export async function apiReference(): Promise<string> {
    return String(await useStorage('assets:docs').getItem('API.md') ?? '')
}

/** The address orrery was reached at, as the agent reading this should use it. */
export function originOf(event: H3Event): string {
    return getRequestURL(event).origin
}

export async function overview(event: H3Event): Promise<string> {
    const origin = originOf(event)
    const projects = await useStore().listProjects()
    return `# orrery

> A local roadmap board for your projects and the Claude Code sessions working on them. Each app's roadmap (chunks of work, issues with
> sub-issues, comments, docs) lives here, kept current by the Claude sessions working in the app's repo
> through a JSON API. The page at ${origin} shows it read-only and updates live.

Use it like this: before a piece of work, create (or pick) its issue and set it to \`in-progress\`, assigned
to yourself; comment as it moves; set it to \`done\` when it ships (\`canceled\` when it's dropped). Keep knowledge (decisions, how
things work) in the project's docs. Name yourself on every write with the header \`Orrery-Actor: claude\`.
Ids are handed out by orrery: issues are the project's prefix and a number (\`GRE-142\`), chunks a number.
When you need the owner to decide something or give feedback, ask in a comment on the issue with
\`"asks": "decision"\` (or \`"feedback"\`): it waits at the top of their bell until they answer.
Before the code, read the project's docs a task touches (\`GET /api/projects/<project>/docs\` lists them with a summary
each, \`?q=\` searches them), and fix one when it turns out wrong.
When you open a pull request for an issue, link the issue's page (${origin}/p/<project>/issues/<id>) in its
description, so the owner can jump to it.

## Docs

- [API reference](${origin}/api/guide): every route, field and rule
- [Everything in one file](${origin}/llms-full.txt): this overview and the API reference

## Projects

${projects.map(p => `- ${p.name}: id \`${p.id}\`, prefix \`${p.key}\`, ${p.kinds.done}/${total(p.kinds)} done (${origin}/api/projects/${p.id})`).join('\n') || '- none yet: create one with POST /api/projects'}
`
}
