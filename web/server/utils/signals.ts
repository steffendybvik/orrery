import type {Signal} from '#shared/roadmap'

/** What makes a signal a repeat of another: a schedule's message, its text, and who it's for. Nothing for other signals. */
export function repeatKey(s: Signal): string | undefined {
    return s.kind === 'message' && s.schedule !== undefined ? JSON.stringify([s.schedule, s.note ?? '', s.target ?? '']) : undefined
}

/** The pull request orrery's own word on an issue is about (pull-comments.ts opens each with its link), as `repo#n`. */
const PULL_NEWS = /^\[#(\d+)\]\(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\1\)/

/** What makes a signal in a backlog stale beside a newer one (ORR-1178): a schedule's repeat (`repeatKey`); a focus on
 * the same issue for the same sessions; orrery's news of the same pull request on the same issue, where the newest
 * (merged) says what's true now and an older one (conflicts, checks fail) no longer is. */
export function foldKey(s: Signal): string | undefined {
    const repeat = repeatKey(s)
    if (repeat) return repeat
    if (s.kind === 'focus' && s.issue) return JSON.stringify(['focus', s.issue, s.target ?? ''])
    const pull = s.kind === 'comment' && s.created_by === 'orrery' && s.issue ? PULL_NEWS.exec(s.note ?? '') : null
    return pull ? JSON.stringify(['pull', s.issue, pull[2], pull[1], s.target ?? '']) : undefined
}

/** A backlog of signals with what's stale folded (`foldKey`): of those alike, only the newest is kept (where it came, so
 * the order stays); the others are `repeats`, which count as heard. */
export function foldRepeats(signals: Signal[]): {kept: Signal[], repeats: Signal[]} {
    const newest = new Map<string, number>()
    for (const s of signals) {
        const k = foldKey(s)
        if (k) newest.set(k, Math.max(newest.get(k) ?? 0, s.id))
    }
    const repeat = (s: Signal) => {
        const k = foldKey(s)
        return !!k && newest.get(k) !== s.id
    }
    return {kept: signals.filter(s => !repeat(s)), repeats: signals.filter(repeat)}
}
