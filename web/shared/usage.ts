// Counting feature use (ORR-881): which of orrery's features the owner uses, so what goes unused can be pruned. Pages and
// MCP tools are counted as they're used, by name (`page:<route>`, `tool:<name>`), and each dialog as it opens
// (`dialog:<name>`, ORR-1011); the optional features below are
// listed even before their first use, so one never used shows at the top of App settings' Usage. Each is counted at its
// one route on the server, or on the page for the three with none (the board view, the palette, the demo project).

/** The optional features worth asking "is this used?" of, each counted where it's used. Core actions aren't here. */
export const FEATURES = {
    'board-view': 'The board view',
    'command-palette': 'The command palette',
    'milestones': 'Making a milestone',
    'schedules': 'Making a schedule',
    'presets': 'Making a preset',
    'message-sessions': 'Message sessions',
    'demo-project': 'The demo project',
    'backup-now': 'Back up now',
    'focus-issue': 'Focus on this',
    'start-session': 'Start session',
    'watch-session': 'Watch a session',
    'phone-code': 'Open on your phone',
    'chat': 'Starting a chat',
} as const

export type Feature = keyof typeof FEATURES | `page:${string}` | `tool:${string}` | `dialog:${string}`

/** A name a feature can be counted under: a listed one, or a page's, tool's or dialog's, short and plain. */
export const FEATURE_NAME = /^((page|tool|dialog):[a-z0-9_-]{1,80}|[a-z0-9-]{1,40})$/

export interface FeatureUse {
    feature: string
    /** What App settings calls it: the listed name, else the page's, tool's or dialog's own. */
    label: string
    /** The last day it was used, `YYYY-MM-DD`, or none. */
    last: string | null
    days30: number
    days90: number
}
