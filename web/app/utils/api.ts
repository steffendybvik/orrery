import type {NitroFetchOptions, NitroFetchRequest} from 'nitropack'

// The one way the page reaches orrery's API (ORR-666): every call, live update and upload's address comes through here,
// by its path under `/api`, so the page isn't tied to the server that served it. It stays same-origin for now.
const API_BASE = '/api'

/** The full address of an API path, for what isn't a fetch: the live feed, an image. */
export const apiUrl = (path: string) => `${API_BASE}${path}`

type ApiOptions = NitroFetchOptions<NitroFetchRequest>

/** Asks the API at `path`. A write goes as the owner (`Orrery-Actor`), unless the call says otherwise with `headers`. */
export async function apiFetch<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const write = (options.method ?? 'GET').toUpperCase() !== 'GET'
    const headers = options.headers ?? (write ? {'Orrery-Actor': await useOwner().load()} : undefined)
    return await $fetch<T>(apiUrl(path), {...options, ...headers ? {headers} : {}} as ApiOptions) as T
}
