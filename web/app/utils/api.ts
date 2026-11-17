import type {NitroFetchOptions, NitroFetchRequest} from 'nitropack'

// The one way the page reaches orrery's API (ORR-666): every call, live update and upload's address comes through here,
// by its path under `/api`, so the page isn't tied to the server that served it. Same-origin by default; `apiBases`
// (public runtime config, NUXT_PUBLIC_API_BASES) sends the paths under a prefix to another base instead, a domain at a
// time (ORR-943), e.g. `{"/projects/atlas/docs": "https://api.example.com/api"}`. The longest prefix that matches
// wins, and what none matches stays on `/api`. A `/` prefix takes every path: a frontend hosted apart from its server
// (ORR-667).
const API_BASE = '/api'

/** The base for `path`: the longest prefix in `bases` that it's under (the prefix itself, or past a `/` or `?` after
 * it; every path is under `/`), else the same-origin `/api`. A base is written without its trailing `/`. */
export function baseFor(path: string, bases: Record<string, string> | undefined): string {
    let best = ''
    for (const prefix of Object.keys(bases ?? {})) {
        if (prefix.length <= best.length || !prefix.startsWith('/')) continue
        const at = path.charAt(prefix.length)
        if (path.startsWith(prefix) && (prefix === '/' || at === '' || at === '/' || at === '?')) best = prefix
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

/** The address of the server this page uses: where sessions, the launcher and curl reach it (`/connect`, `/channel`,
 * keys.json's line). The page's own origin, unless it's hosted apart from its server (ORR-667), when it's the API's. */
export function serverOrigin(): string {
    if (!import.meta.client) return 'http://localhost:9000'
    return new URL(apiUrl('/'), location.href).origin
}

/** Whether `path` goes to another address than the page's: a call there sends this browser's login with it
 * (`credentials`, `withCredentials`), which that server has to allow (CORS with credentials, for this page's origin). */
export const apiCrossOrigin = (path: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(baseFor(path, bases()))

type ApiOptions = NitroFetchOptions<NitroFetchRequest>

/** The workspace a page's address is in, `/w/<workspace>/…` (ORR-1108), else none. It's read from the address each
 * time, never kept, so two tabs can sit in different workspaces. */
export function workspaceIn(pathname: string): string | undefined {
    const raw = /^\/w\/([^/?#]+)/.exec(pathname)?.[1]
    if (!raw) return undefined
    try {
        const workspace = decodeURIComponent(raw)
        return /^[\x21-\x7e]{1,64}$/.test(workspace) ? workspace : undefined
    } catch {
        return undefined
    }
}

/** The pages outside every workspace, the installation's: signing in and connecting a machine or a repo. Every other
 * page is under one, at `/w/<workspace>/…` (ORR-1275). */
export const OUTSIDE_WORKSPACE = ['/login', '/connect', '/connect-machine']

/** The first part of a workspace's own pages' paths (`/w/<workspace>/settings`): what a project's id can't be, as its
 * pages are at `/w/<workspace>/<project>/…` (ORR-1275). Kept with `RESERVED_PROJECT_IDS` in api/src/text.rs. */
export const WORKSPACE_PAGES = [
    'chat', 'connect', 'connect-machine', 'context', 'epics', 'events', 'getting-started', 'login', 'mine', 'notifications', 'now', 'p',
    'projects', 'pulls', 'releases', 'schedules', 'sessions', 'settings', 'ui', 'urgent', 'w',
]

const isOutside = (path: string) => OUTSIDE_WORKSPACE.includes(path.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/')

/** Where a page is in `workspace`, from its path within one (`pagePath`): `/w/<workspace><path>`, a project's pages
 * without their `/p` (`/p/rockets/issues` is `/w/acme/rockets/issues`, ORR-1275). A page outside every workspace, or
 * one already under one, stays as it is. */
export function inWorkspace(workspace: string, path: string): string {
    if (isOutside(path) || workspaceIn(path)) return path
    const within = path.replace(/^\/p(?=\/)/, '')
    return `/w/${encodeURIComponent(workspace)}${within === '/' ? '' : within.replace(/^\/(?=[?#])/, '')}`
}

/** The page's own path, without the `/w/<workspace>` it's under: what a link or a highlight compares, and what links
 * in the app are written as. A project's pages read as `/p/<project>/…`, as they did before ORR-1275, so
 * `/w/acme/rockets/issues` is `/p/rockets/issues`, and `/w/acme/mine` is `/mine`. */
export function pagePath(pathname: string): string {
    const rest = pathname.replace(/^\/w\/[^/?#]+/, '')
    if (pathname === rest) return pathname
    const first = /^\/([^/?#]+)/.exec(rest)?.[1]
    return !first ? rest || '/' : WORKSPACE_PAGES.includes(first) ? rest : `/p${rest}`
}

/** `Orrery-Workspace` for this tab's address, for the API's workspace-wide rows (epics, statuses, presets…). */
function workspaceHeader(): Record<string, string> {
    const workspace = import.meta.client ? workspaceIn(location.pathname) : undefined
    return workspace ? {'Orrery-Workspace': workspace} : {}
}

/** Asks the API at `path`. A write goes as the owner (`Orrery-Actor`), or who this browser is acting as (ORR-657), which
 * a read says too, so the bell is theirs. A call says otherwise with `headers`. */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const write = (options.method ?? 'GET').toUpperCase() !== 'GET'
    const acting = useState<string | null>('acting', () => null).value
    const own = options.headers ?? (acting ? {'Orrery-Actor': acting} : write ? {'Orrery-Actor': await useOwner().load()} : undefined)
    // The tab's workspace goes with every call, unless the call names one itself.
    const workspace = workspaceHeader()
    const plain = !own || (typeof own === 'object' && !Array.isArray(own) && !(own instanceof Headers))
    const headers = Object.keys(workspace).length && plain ? {...workspace, ...own as Record<string, string> | undefined} : own
    const away = apiCrossOrigin(path) ? {credentials: 'include' as const} : {}
    // The global one, which plugins/unseen.client.ts wraps: a plain `$fetch` here is auto-imported as the one underneath it.
    return await globalThis.$fetch<T>(apiUrl(path), {...away, ...options, ...headers ? {headers} : {}} as ApiOptions) as T
}
