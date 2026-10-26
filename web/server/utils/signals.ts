import type {Signal} from '#shared/roadmap'

/** A backlog of signals with a schedule's repeats folded: of the messages one schedule sent with the same text to the
 * same sessions, only the newest is kept (where it came, so the order stays); the others are `repeats`. */
/** What makes a signal a repeat of another: a schedule's message, its text, and who it's for. Nothing for other signals. */
export function repeatKey(s: Signal): string | undefined {
    return s.kind === 'message' && s.schedule !== undefined ? JSON.stringify([s.schedule, s.note ?? '', s.target ?? '']) : undefined
}

export function foldRepeats(signals: Signal[]): {kept: Signal[], repeats: Signal[]} {
    const key = repeatKey
    const newest = new Map<string, number>()
    for (const s of signals) {
        const k = key(s)
        if (k) newest.set(k, Math.max(newest.get(k) ?? 0, s.id))
    }
    const repeat = (s: Signal) => {
        const k = key(s)
        return !!k && newest.get(k) !== s.id
    }
    return {kept: signals.filter(s => !repeat(s)), repeats: signals.filter(repeat)}
}
