// What a session hears when the owner asks it to focus: a template with `{placeholders}`, the orrery's
// or a project's own, and the standing instructions picked for that send. The server renders it for the
// channel, and the settings pages render it for their preview.

/** A standing instruction: a line added to every focus (`commit whenever a piece works`), ticked by default when `on`. */
export interface Instruction {
    id: string
    text: string
    on: boolean
}

export const DEFAULT_FOCUS_PROMPT = [
    '{actor} asks you to focus on {issue}: {title} [{where}].',
    'Note: {note}',
    'Read it with: curl {url}',
    'Read the project docs it touches before the code, and fix any that turn out wrong.',
].join('\n')

export const DEFAULT_CHUNK_PROMPT = [
    '{actor} asks you to work through the {status} issues in chunk {chunk}: {title} [{where}].',
    'Note: {note}',
    'Its {status} issues, most urgent first:',
    '{issues}',
    'Take them one at a time as you would a focus on each (in-progress, the docs they touch, comments, done). Read them with: curl {url}',
].join('\n')

/** The placeholders each template fills, with what they become. */
export const PLACEHOLDERS = {
    focus: {
        actor: 'who asked (the owner)',
        issue: 'its id, e.g. GRE-42',
        title: 'its title',
        status: "its status's name",
        priority: 'its priority, e.g. P1',
        chunk: "its chunk's title",
        where: 'status, priority and chunk, comma-separated',
        note: 'the note sent with it',
        url: 'its address in the API',
        instructions: 'the standing instructions, one per line (added at the end when left out)',
    },
    chunk: {
        actor: 'who asked (the owner)',
        chunk: "the chunk's id",
        title: "the chunk's title",
        status: 'the status asked for, or "open"',
        priority: "the chunk's priority",
        where: "the chunk's status and priority",
        note: 'the note sent with it',
        issues: 'its issues, one per line, most urgent first',
        url: "the chunk's address in the API",
        instructions: 'the standing instructions, one per line (added at the end when left out)',
    },
} as const

const PLACEHOLDER = /\{([a-z]+)\}/g
const KNOWN = new Set<string>([...Object.keys(PLACEHOLDERS.focus), ...Object.keys(PLACEHOLDERS.chunk)])

/** Fills the template. A line whose placeholders all come out empty is left out (`Note: {note}` without a
 * note), and an unknown placeholder stays as written. The instructions go where `{instructions}` is, or
 * at the end under "Also:". */
export function renderPrompt(template: string, values: Record<string, string | null | undefined>, instructions: string[] = []): string {
    const list = instructions.map(text => `- ${text}`).join('\n')
    const all: Record<string, string> = {
        ...Object.fromEntries([...KNOWN].map(name => [name, ''])),
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? ''])),
        instructions: list,
    }
    const lines = template.split('\n').flatMap(line => {
        const names = [...line.matchAll(PLACEHOLDER)].flatMap(m => m[1] ?? []).filter(name => Object.hasOwn(all, name))
        if (names.length && names.every(name => !all[name])) return []
        return [line.replace(PLACEHOLDER, (whole, name: string) => Object.hasOwn(all, name) ? all[name] ?? whole : whole)]
    })
    const text = lines.join('\n').trim()
    return list && !template.includes('{instructions}') ? `${text}\n\nAlso:\n${list}` : text
}

/** The instructions ticked for a send when it doesn't say: the orrery's that are on, less those the project
 * switched off, and the project's own that are on. */
export function defaultInstructions(global: Instruction[], own: Instruction[], muted: string[]): Instruction[] {
    return [...global.filter(i => i.on && !muted.includes(i.id)), ...own.filter(i => i.on)]
}
