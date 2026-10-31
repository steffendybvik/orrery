// How much this browser uses each ⌘K command (ORR-782), for the palette's Most used. Each run counts for 1, halving every
// two weeks, so it follows changing habits. Kept in this browser alone, by the command's key.
const STORE = 'orrery-palette-use'
const HALF_LIFE = 14 * 86_400_000
/** About three runs lately: one use doesn't pin a command. */
const PINNED_FROM = 2.5
/** Below this it's as good as forgotten, and comes off the list. */
const FORGOTTEN = 0.05

interface Use { score: number, at: number }

const faded = ({score, at}: Use, now: number) => score * 0.5 ** ((now - at) / HALF_LIFE)

function read(): Record<string, Use> {
    try {
        const stored = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, Use>
        return stored && typeof stored === 'object' ? stored : {}
    } catch {
        return {}
    }
}

/** Counts a run of the command `key`. */
export function recordCommand(key: string, now = Date.now()) {
    const uses = Object.entries(read()).filter(([, use]) => faded(use, now) >= FORGOTTEN)
    const kept = Object.fromEntries(uses)
    kept[key] = {score: (kept[key] ? faded(kept[key], now) : 0) + 1, at: now}
    try {
        localStorage.setItem(STORE, JSON.stringify(kept))
    } catch {
        // No room or no storage: the palette goes on as it was.
    }
}

/** The commands used enough to lead the palette, most used first. */
export function mostUsedCommands(now = Date.now()): string[] {
    return Object.entries(read())
        .map(([key, use]) => ({key, score: faded(use, now)}))
        .filter(use => use.score >= PINNED_FROM)
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
        .map(use => use.key)
}
