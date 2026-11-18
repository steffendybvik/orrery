import type {Project} from '#shared/roadmap'
import {open} from '#shared/roadmap'

/** The project a page of no project opens on, such as the chat or Context (ORR-1284): the one last used in this
 * browser, else the first starred one, else the one with the most open issues (ties in the sidebar's order). Hidden
 * ones come last, so an empty or hidden project is the pick only when nothing else is. `ordered` is the sidebar's order. */
export function defaultProject(ordered: Project[], last: string | null, starred: (id: string) => boolean, hidden: (id: string) => boolean): Project | undefined {
    const used = last ? ordered.find(p => p.id === last) : undefined
    if (used) return used
    const star = ordered.find(p => starred(p.id))
    if (star) return star
    const shown = ordered.filter(p => !hidden(p.id))
    return [...(shown.length ? shown : ordered)].sort((a, b) => open(b.board.kinds) - open(a.board.kinds))[0]
}
