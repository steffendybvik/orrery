import type {OnFilter} from './happenings'

// Ready-made event schedules for the presets Orrery ships (ORR-344), offered on Schedules. None is made until the owner
// adds it: starting sessions on its own is theirs to turn on. Each names its presets by key (shared/presets.ts), as
// the Orrery's own presets carry it, so it finds them in any Orrery; one the owner removed is left out.
export interface ScheduleSuggestion {
    key: string
    title: string
    kind: 'message' | 'session'
    on: string
    on_filter?: OnFilter
    presets: string[]
    notes?: string
    /** When it runs, as the row says it. */
    when: string
}

export const SCHEDULE_SUGGESTIONS: ScheduleSuggestion[] = [
    {
        key: 'release-frozen', title: 'Release a frozen release', kind: 'session', on: 'release.frozen',
        presets: ['release', 'security-audit'], when: 'When a release is frozen',
    },
    {
        key: 'release-shipped', title: 'Get the next release going', kind: 'message', on: 'release.shipped', presets: [],
        notes: "A release just shipped. Get the next one going: make it in Orrery if it isn't there yet, and set the issues still open in the one that shipped for it.",
        when: 'When a release ships',
    },
    {
        key: 'review', title: 'Review an issue in review', kind: 'session', on: 'issue.status', on_filter: {to: 'in-review'},
        presets: ['review'], when: 'When an issue moves to In review',
    },
    {
        key: 'debug-error', title: 'Debug a new error', kind: 'session', on: '*.error', presets: ['debug-error'],
        when: 'When a new error is logged',
    },
]
