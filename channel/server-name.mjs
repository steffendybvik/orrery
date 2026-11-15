// The channel's server name, in a repo's .mcp.json and in the agent's user config (ORR-1193): always `orrery`, as the
// owner asked, now that one orrery holds several workspaces and the environment name (personal, work) is gone. A
// machine on two orreries still needs two names: the second takes its host (`orrery-orrery-dybben-com`) rather than
// replacing the first. `environment` is ignored, kept for callers from before.
const slug = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

export function serverName(_environment) {
    return 'orrery'
}

/** The name for the orrery `id` at `url` among the `servers` already there ({name, id}, `id` undefined for one that
 * isn't an orrery's): `orrery` unless another orrery or another tool holds it, then `orrery-<host>`, then with `-2`… */
export function freeServerName(url, id, servers) {
    const held = name => servers.some(s => s.name === name && s.id !== id)
    if (!held('orrery')) return 'orrery'
    let host = 'other'
    try {
        host = slug(new URL(url).hostname) || host
    } catch {
        // Not a URL: the plain fallback.
    }
    const base = `orrery-${host}`
    let name = base
    for (let n = 2; held(name); n++) name = `${base}-${n}`
    return name
}

/** The name an orrery's server had before ORR-1193, `orrery-<environment>`, which setups made then still use. */
export function legacyServerName(environment) {
    return `orrery-${slug(environment) || 'orrery'}`
}
