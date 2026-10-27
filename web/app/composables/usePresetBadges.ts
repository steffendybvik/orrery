import type {Preset} from '#shared/roadmap'

/** The presets a started session was given, as badges: its context keeps only their names, so each is found among
 * the presets its project's sessions can have (fetched once per project, the project's own before the Orrery's). One
 * renamed or removed since shows as its initials. `forget` drops what's known, after a preset changes. */
export function usePresetBadges() {
    const known = useState<Record<string, Preset[]>>('preset-badges', () => ({}))
    function load(project: string) {
        if (known.value[project]) return
        known.value = {...known.value, [project]: []}
        $fetch<Preset[]>(`/api/projects/${encodeURIComponent(project)}/presets`)
            .then(all => known.value = {...known.value, [project]: all})
            .catch(() => {})
    }
    const badgesFor = (project: string, names: string[]) => names.map(name => known.value[project]?.findLast(p => p.name === name) ?? {name})
    const forget = () => known.value = {}
    return {load, badgesFor, forget}
}
