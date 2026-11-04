// Counting feature use (ORR-881): which of orrery's features the owner uses, so what goes unused can be pruned. Pages and
// MCP tools are counted as they're used, by name (`page:<route>`, `tool:<name>`); the optional features below are
// listed even before their first use, so one never used shows at the top of App settings' Usage.

/** The optional features worth asking "is this used?" of, each counted where it's used. Core actions aren't here. */
export const FEATURES = {
    'board-view': 'The board view',
    'chunks': 'Chunks',
    'schedules': 'Schedules',
    'presets': 'Presets',
    'message-sessions': 'Message sessions',
    'demo-project': 'The demo project',
    'backup-now': 'Back up now',
    'tracker-link': 'The team tracker link',
    'focus-issue': 'Focus on this',
    'start-session': 'Start session',
    'watch-session': 'Watch a session',
    'phone-code': 'Open on your phone',
    'chat': 'The chat',
    'docs': 'Docs',
    'releases': 'Releases',
    'command-palette': 'The command palette',
} as const

export type Feature = keyof typeof FEATURES | `page:${string}` | `tool:${string}`

/** A name a feature can be counted under: a listed one, or a page's or tool's, short and plain. */
export const FEATURE_NAME = /^((page|tool):[a-z0-9_-]{1,80}|[a-z0-9-]{1,40})$/

export interface FeatureUse {
    feature: string
    /** What App settings calls it: the listed name, else the page's or tool's own. */
    label: string
    /** The last day it was used, `YYYY-MM-DD`, or none. */
    last: string | null
    days30: number
    days90: number
}
