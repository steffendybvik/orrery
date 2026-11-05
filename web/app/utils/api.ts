import type {NitroFetchOptions, NitroFetchRequest} from 'nitropack'

// The one way the page reaches orrery's API (ORR-666): every call, live update and upload's address comes through here,
// by its path under `/api`, so the page isn't tied to the server that served it. Same-origin by default; `apiBases`
// (public runtime config, NUXT_PUBLIC_API_BASES) sends the paths under a prefix to another base instead, a domain at a
// time (ORR-943), e.g. `{"/projects/atlas/docs": "https://api.example.com/api"}`. The longest prefix that matches
// wins, and what none matches stays on `/api`.
const API_BASE = '/api'

/** The base for `path`: the longest prefix in `bases` that it's under (the prefix itself, or past a `/` or `?` after
 * it), else the same-origin `/api`. A base is written without its trailing `/`. */
export function baseFor(path: string, bases: Record<string, string> | undefined): string {
    let best = ''
    for (const prefix of Object.keys(bases ?? {})) {
        if (prefix.length <= best.length || !prefix.startsWith('/')) continue
        const at = path.charAt(prefix.length)
        if (path.startsWith(prefix) && (at === '' || at === '/' || at === '?')) best = prefix
    }
    const base = best ? bases?.[best] : undefined
    return base ? base.replace(/\/+$/, '') : API_BASE
}

/** The prefixes the page sends elsewhere, from runtime config; none outside a Nuxt app (a unit test of a util). */
function bases(): Record<string, string> | undefined {
    try {
        const set = useRuntimeConfig().public.apiBases as Record<string, string> | string | undefined
        return typeof set === 'string' ? (set ? JSON.parse(set) as Record<string, string> : undefined) : set
    } catch {
        return undefined
    }
}

/** The full address of an API path, for what isn't a fetch: the live feed, an image. */
export const apiUrl = (path: string) => `${baseFor(path, bases())}${path}`

/** Whether `path` goes to another address than the page's: a call there sends this browser's login with it
 * (`credentials`, `withCredentials`), which that server has to allow (CORS with credentials, for this page's origin). */
export const apiCrossOrigin = (path: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(baseFor(path, bases()))

type ApiOptions = NitroFetchOptions<NitroFetchRequest>

/** Asks the API at `path`. A write goes as the owner (`Orrery-Actor`), or who this browser is acting as (ORR-657), which
 * a read says too, so the bell is theirs. A call says otherwise with `headers`. */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const write = (options.method ?? 'GET').toUpperCase() !== 'GET'
    const acting = useState<string | null>('acting', () => null).value
    const headers = options.headers ?? (acting ? {'Orrery-Actor': acting} : write ? {'Orrery-Actor': await useOwner().load()} : undefined)
    const away = apiCrossOrigin(path) ? {credentials: 'include' as const} : {}
    // The global one, which plugins/unseen.client.ts wraps: a plain `$fetch` here is auto-imported as the one underneath it.
    return await globalThis.$fetch<T>(apiUrl(path), {...away, ...options, ...headers ? {headers} : {}} as ApiOptions) as T
}
