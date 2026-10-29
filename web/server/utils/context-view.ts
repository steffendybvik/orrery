// What orrery puts into a session's context, part by part with its size (ORR-549), so the owner can see what to cut:
// the channel's instructions and every tool it lists (built by the channel's own code, `instructionsFor` and
// `toolsFor`, so it's what's sent), and the context the session was started with, as its first signal and its brief
// after a `/clear` carry it. For a kind of session (a work session, the owner's chat, an untrusted schedule's run),
// or for one that's running. Sizes are characters, and tokens estimated as a quarter of them.
import {instructionsFor} from '#channel/instructions.mjs'
import {toolsFor} from '#channel/tools.mjs'
import type {ContextKind, ContextPart, ContextView} from '#shared/context'

const tokens = (chars: number) => Math.ceil(chars / 4)
/** What the channel says it serves, as orrery-channel.mjs words it. */
const servesLine = (projects: string[]) => projects.length === 1 ? `project "${projects[0]}"` : `projects ${projects.map(p => `"${p}"`).join(', ')}`
const part = (id: string, group: ContextPart['group'], title: string, text: string): ContextPart =>
    ({id, group, title, text, chars: text.length, tokens: tokens(text.length)})

/** What a session of `kind` hearing `projects` on the orrery at `base` is given, with `start` (its start context as
 * it's told it) when it has one; biggest first within each group. */
export function contextView(kind: ContextKind, projects: string[], base: string, start?: string, session?: string): ContextView {
    const chat = kind === 'chat'
    const tools = (toolsFor(projects, {chat, untrusted: kind === 'untrusted'}) as {name: string}[])
        .map(tool => part(`tool:${tool.name}`, 'tools', tool.name, JSON.stringify(tool, null, 2)))
        .sort((a, b) => b.chars - a.chars)
    const parts = [
        part('instructions', 'instructions', 'Server instructions', instructionsFor({base, serves: servesLine(projects), chat, several: projects.length > 1})),
        ...tools,
        ...start ? [part('start', 'start', 'Start context', start)] : [],
    ]
    const chars = parts.reduce((sum, p) => sum + p.chars, 0)
    return {kind, projects, ...session ? {session} : {}, parts, chars, tokens: tokens(chars)}
}

/** The view for a running session: its kind, the projects it hears, the context it was started with, and what it's
 * been given since (`contextSoFar`). */
export function sessionContextView(id: string, base: string): ContextView | undefined {
    const session = sessionNow(id)
    if (!session) return undefined
    const kind: ContextKind = chatSession(id) ? 'chat' : untrustedSession(id) ? 'untrusted' : 'work'
    const given = session.started?.launch ? launchContext(session.project, session.started.launch) : undefined
    return {...contextView(kind, [session.project, ...session.also ?? []], base, given ? contextBlock(given) : undefined, currentId(id)), sofar: contextSoFar(id)}
}
