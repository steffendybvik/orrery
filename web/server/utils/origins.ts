// The other sites' pages that may use this orrery's API from a browser (ORR-667): a frontend built on its own and hosted
// elsewhere. Off by default, so another site's page can neither write here nor read the answers. A listed origin is one
// exact `scheme://host[:port]`: no wildcards, and never `null` (a sandboxed frame or a file), as a loose rule would let any
// website the owner visits read and write their orrery, and so instruct their agents. Set with NUXT_ALLOWED_ORIGINS
// (ORRERY_ALLOWED_ORIGINS in compose), comma-separated.

/** An origin as a browser sends it (`https://app.example.com`), or nothing when `value` isn't a plain http(s) one. */
export function asOrigin(value: string): string | undefined {
    try {
        const url = new URL(value.trim())
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
        if (url.username || url.password || url.pathname.replace(/\/+$/, '') || url.search || url.hash) return undefined
        return url.origin
    } catch {
        return undefined
    }
}

/** The origins the setting lists, each as a browser sends it; what isn't an origin is left out. */
export function allowedOrigins(setting = String(useRuntimeConfig().allowedOrigins ?? '')): Set<string> {
    return new Set(setting.split(',').map(asOrigin).filter((origin): origin is string => !!origin))
}

/** Whether a request's `Origin` is one of the listed sites' (compared exactly, as the browser sends it). */
export function originAllowed(origin: string | undefined, setting?: string): boolean {
    return !!origin && origin !== 'null' && allowedOrigins(setting).has(origin)
}
