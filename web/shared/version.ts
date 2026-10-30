// Comparing orrery's versions (`1.0.0`, `1.0.0-rc.10`), for the Sessions page to mark a channel running code older than
// the orrery (ORR-434), or a launcher too old for it (ORR-686). A prerelease comes before its release, and `rc.9` before
// `rc.10`.

/** Whether `version` is older than `than`; one that's unknown (from a channel or launcher too old to say) is. */
export function olderVersion(version: string | undefined, than: string): boolean {
    if (!version) return true
    return compare(version, than) < 0
}

/** The oldest launcher that does all this orrery asks of one (ORR-686), going by what changed for the launcher rather
 * than the release: since 1.0.0-rc.10 it says its version, sends its token and can start a chat or a locked-down session.
 * With several people, a session it starts also has to say whose it is, which came in 1.0.0-rc.15. Raise this when the
 * server comes to need something new of a launcher. */
export function launcherMinimum(people: number): string {
    return people > 1 ? '1.0.0-rc.15' : '1.0.0-rc.10'
}

function compare(a: string, b: string): number {
    const [aMain = '', ...aPre] = a.split('-')
    const [bMain = '', ...bPre] = b.split('-')
    const main = parts(aMain, bMain)
    if (main) return main
    const [ap, bp] = [aPre.join('-'), bPre.join('-')]
    if (!ap || !bp) return ap ? -1 : bp ? 1 : 0
    return parts(ap, bp)
}

/** Dot by dot: numbers as numbers, words as text, a shorter list first when the rest is equal. */
function parts(a: string, b: string): number {
    const [as, bs] = [a.split('.'), b.split('.')]
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const [x, y] = [as[i], bs[i]]
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1
        const [nx, ny] = [Number(x), Number(y)]
        const order = Number.isInteger(nx) && Number.isInteger(ny) ? nx - ny : x.localeCompare(y)
        if (order) return Math.sign(order)
    }
    return 0
}
