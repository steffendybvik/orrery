// Which spec files a shard of the browser suite runs (ORR-920), so CI can run it as several jobs at once, each its own
// `nuxt dev` and database. Playwright's own `--shard` can't: a project it needs first runs whole in every shard, and in
// the whole suite `alone` needs every other group. Here each shard is the whole suite's shape over a share of the files:
// first-run first, then its share of each group, taking turns as they do, and its share of `alone` last.
//
// Shares are balanced by how long each spec took (e2e/durations.json, scripts/e2e-durations.mjs), as a few specs take
// minutes and most seconds. A group that takes turns adds up one after another; the rest share the workers.

export type Group = 'free' | 'sessions' | 'settings' | 'alone'

/** `heavy`: a page walk (ORR-920), minutes of pages loaded one after another. A few at once in one shard load its server
 * past what a slow browser bears, so they're spread out as if they took turns. */
export interface Spec {name: string, group: Group, heavy?: boolean}

/** `E2E_SHARD` (`2/3`) as numbers; none, or not that shape, is the whole suite. */
export function shardSetting(value: string | undefined): {index: number, total: number} | null {
    const match = /^(\d+)\/(\d+)$/.exec(value?.trim() ?? '')
    if (!match) return null
    const [index, total] = [Number(match[1]), Number(match[2])]
    return total > 1 && index >= 1 && index <= total ? {index, total} : null
}

/** How long a shard should take, by its specs' seconds: the groups that take turns run one after another beside the rest,
 * which share the workers, and `alone` after all of them. */
export function shardSeconds(specs: Spec[], seconds: (name: string) => number, workers: number): number {
    const sum = (group: Group) => specs.filter(s => s.group === group).reduce((total, s) => total + seconds(s.name), 0)
    const [free, sessions, settings] = [sum('free'), sum('sessions'), sum('settings')]
    const heavy = specs.filter(s => s.heavy).reduce((total, s) => total + seconds(s.name), 0)
    return Math.max(sessions, settings, heavy, (free + sessions + settings) / workers) + sum('alone')
}

/** The specs in each of `total` shards: every spec in one, the longest placed first wherever it makes the slowest shard
 * least slow. The same specs and times give the same shards on every machine. */
export function shards(specs: Spec[], total: number, durations: Record<string, number>, workers = 4): Spec[][] {
    const known = Object.values(durations).sort((a, b) => a - b)
    const middling = known[Math.floor(known.length / 2)] ?? 30
    const seconds = (name: string) => durations[name] ?? middling
    const out: Spec[][] = Array.from({length: total}, () => [])
    const order = [...specs].sort((a, b) => seconds(b.name) - seconds(a.name) || a.name.localeCompare(b.name))
    for (const spec of order) {
        // Where the slowest shard ends least slow; between those, the one this shard ends least slow itself.
        let best = 0
        let [bestSlowest, bestOwn] = [Infinity, Infinity]
        for (let i = 0; i < total; i++) {
            const after = out.map((shard, j) => shardSeconds(j === i ? [...shard, spec] : shard, seconds, workers))
            const [slowest, own] = [Math.max(...after), after[i] ?? 0]
            if (slowest < bestSlowest || (slowest === bestSlowest && own < bestOwn)) [best, bestSlowest, bestOwn] = [i, slowest, own]
        }
        ;(out[best] ??= []).push(spec)
    }
    return out
}
