import type {Project} from '#shared/roadmap'
import {connectPieces, idsFor} from '#shared/connect'

/** What sets a repo up for `project` on this orrery: the line to give a Claude session there, the line that starts
 * one with the channel, and the pieces to do it by hand (see `connectPieces`). With no project, one named `name`
 * that the session makes. Connect an agent and Getting started both show them. */
export function useConnect(project: Ref<Project | undefined>, options: {name?: Ref<string>, session?: Ref<string>} = {}) {
    const config = useRuntimeConfig()
    const {settings} = useAppSettings()
    const origin = serverOrigin()
    return computed(() => {
        const name = project.value?.name ?? (options.name?.value.trim() || 'my-app')
        return connectPieces({
            origin,
            id: project.value?.id ?? idsFor(name).id,
            name,
            key: project.value?.key ?? idsFor(name).key,
            isNew: !project.value,
            session: options.session?.value ?? '',
            orrery: settings.value.id ? {id: settings.value.id, environment: String(config.public.environment || 'personal')} : undefined,
        })
    })
}
