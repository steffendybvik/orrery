import {join} from 'node:path'

// Where a path inside the container is on the computer Docker runs on (ORR-399): compose mounts `/data` and `/backup`
// from `ORRERY_DATA` and `ORRERY_BACKUP`, each a folder of the owner's or, without one, a named volume, and passes the
// same value in (`NUXT_DATA_HOST`, `NUXT_BACKUP_HOST`), so App settings can say `~/Orrery/orrery.db` rather than
// `/data/orrery.db`, which means nothing on the computer. Outside Docker nothing is passed, and paths are already its.

/** A path as the computer has it (`host`), or the Docker volume it's in (`volume`); neither when it isn't known. */
export interface HostPlace {
    host?: string
    volume?: string
}

/** Where `path` is on the computer, when it's under `mount` and compose said what `mount` is (`source`: a folder,
 * absolute, from home or from the compose folder `base`, or else a volume's name, as compose reads a volume line). */
export function onHost(path: string, mount: string, source: string | undefined, base: string): HostPlace {
    const from = source?.trim()
    if (!from || (path !== mount && !path.startsWith(`${mount}/`))) return {}
    const rest = path.slice(mount.length)
    if (!/^[/~.]/.test(from)) return {volume: from}
    const folder = from.startsWith('.') && base ? join(base, from) : from
    return {host: `${folder.replace(/\/+$/, '')}${rest}`}
}
