/** The value, which the code around it knows is there (found in a list it just checked, a map it just filled);
 * throws, as a bug, when it isn't, rather than going on with undefined. */
export function known<T>(value: T | undefined, what: string): T {
    if (value === undefined) throw new Error(`Expected ${what}`)
    return value
}
