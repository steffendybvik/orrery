// Kinds of work, each with the model and effort a session for it starts on (ORR-868; the `session-models` doc). An
// issue's kind is its highest-ranked label's, so a lighter model never gets work that also carries a heavier label.
import type {Effort} from './sessions'

export interface WorkKind {
    id: string
    name: string
    /** The labels that make an issue this kind, lowercase. */
    labels: string[]
    model: string
    effort?: Effort
}

/** The kinds orrery ships, highest-ranked first. Other is the kind of an issue whose labels match none. Roadmap and Chat
 * are taken from what the work is (the Roadmap tidy schedule, the owner's chat), not from labels. */
export const WORK_KINDS: readonly WorkKind[] = [
    {id: 'security', name: 'Security', labels: ['security'], model: 'best'},
    {id: 'release', name: 'Release', labels: ['release'], model: 'best'},
    {id: 'bug', name: 'Bug', labels: ['bug'], model: 'best'},
    {id: 'feature', name: 'Feature', labels: ['feature', 'feature request', 'improvement'], model: 'best'},
    {id: 'research', name: 'Research', labels: ['research'], model: 'best'},
    {id: 'maintenance', name: 'Maintenance', labels: ['maintenance', 'cleanup', 'test', 'tests', 'ci', 'perf'], model: 'best'},
    {id: 'docs', name: 'Docs', labels: ['docs', 'documentation'], model: 'sonnet'},
    {id: 'roadmap', name: 'Roadmap', labels: [], model: 'sonnet'},
    {id: 'other', name: 'Other', labels: [], model: 'best'},
    {id: 'chat', name: 'Chat', labels: [], model: 'sonnet'},
]

/** The kind of an issue with these labels: the highest-ranked kind any of them belongs to, else Other. */
export function kindOf(labels: readonly string[], kinds: readonly WorkKind[] = WORK_KINDS): WorkKind | undefined {
    const own = new Set(labels.map(l => l.trim().toLowerCase()))
    return kinds.find(k => k.labels.some(l => own.has(l))) ?? kinds.find(k => k.id === 'other')
}

/** How heavy a model is, for never handing work to a lighter one: `best` and a model orrery doesn't know count as the
 * heaviest, as either can do anything. */
const WEIGHT: Record<string, number> = {haiku: 1, sonnet: 2, opus: 3, opusplan: 3, fable: 4}
export function weightOf(model: string | undefined): number {
    if (!model || model === 'best' || model === 'default') return 5
    const family = Object.keys(WEIGHT).find(f => model === f || model.startsWith(`claude-${f}`))
    return family ? WEIGHT[family] ?? 5 : 5
}

/** What a session for an issue starts on: its own model and effort when it has them, else its kind's. */
export function modelFor(issue: {labels: readonly string[], model?: string | null, effort?: Effort | null}, kinds: readonly WorkKind[] = WORK_KINDS): {model?: string, effort?: Effort} {
    const kind = kindOf(issue.labels, kinds)
    const model = issue.model || kind?.model
    const effort = issue.effort || (issue.model ? undefined : kind?.effort)
    return {...model ? {model} : {}, ...effort ? {effort} : {}}
}

/** The heaviest of several issues' models, for a session working through all of them (a chunk or a release). */
export function heaviest(picks: {model?: string, effort?: Effort}[]): {model?: string, effort?: Effort} {
    return picks.reduce<{model?: string, effort?: Effort}>((best, pick) => weightOf(pick.model) > weightOf(best.model) ? pick : best, picks[0] ?? {})
}
