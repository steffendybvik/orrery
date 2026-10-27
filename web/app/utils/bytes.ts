const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** A size as people read it, in powers of 1000: `812 B`, `48 KB`, `12.4 MB`. One decimal under 100. */
export function bytes(size: number): string {
    let unit = 0
    while (size >= 1000 && unit < UNITS.length - 1) {
        size /= 1000
        unit++
    }
    return `${unit && size < 100 ? size.toFixed(1).replace(/\.0$/, '') : Math.round(size)} ${UNITS[unit]}`
}
