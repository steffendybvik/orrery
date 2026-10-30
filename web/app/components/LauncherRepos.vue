<script setup lang="ts">
// The repos the launcher serves (ORR-605), on Sessions → Setup under its install command: each folder its launchers run
// in, with the projects served from it, and whether a Claude session's channel picked it up (ORR-599, and when) or it
// was installed there by hand. Asked of each project, and again as launchers come and go; nothing while none runs.
import type {LaunchState} from '~/composables/useLaunchState'

const {launchers, byId} = useRoadmaps()
const {ordered} = useProjectOrder()
const states = ref<Record<string, LaunchState | null>>({})
async function ask() {
    const asked = await Promise.all(ordered.value.map(async p => [p.id, await $fetch<LaunchState>(`/api/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)] as const))
    states.value = Object.fromEntries(asked)
}
watch([() => ordered.value.map(p => p.id).join(), launchers], ask, {immediate: true})

/** Each folder once, with its projects, picked up when any of them was, at the earliest. */
const repos = computed(() => {
    const byDir = new Map<string, {dir: string, projects: string[], picked_at?: string}>()
    for (const [project, state] of Object.entries(states.value)) {
        for (const {dir, picked_at} of state?.repos ?? []) {
            const repo = byDir.get(dir) ?? {dir, projects: []}
            repo.projects.push(byId(project)?.name ?? project)
            if (picked_at && (!repo.picked_at || picked_at < repo.picked_at)) repo.picked_at = picked_at
            byDir.set(dir, repo)
        }
    }
    return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir))
})
</script>

<template>
  <div v-if="repos.length" class="flex flex-col gap-1.5">
    <h3 class="text-xs font-medium text-fg">Repos it serves</h3>
    <ul class="overflow-hidden rounded-xl border border-line text-xs dark:bg-panel" aria-label="Repos the launcher serves">
      <li v-for="repo in repos" :key="repo.dir" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line px-3 py-2 last:border-b-0">
        <span class="min-w-0 truncate font-mono text-fg" :title="repo.dir">{{ repo.dir }}</span>
        <span class="text-muted">{{ repo.projects.join(', ') }}</span>
        <span class="ml-auto shrink-0 text-faint" :title="repo.picked_at ? new Date(repo.picked_at).toLocaleString() : undefined">
          {{ repo.picked_at ? `picked up ${ago(repo.picked_at)}` : 'installed' }}
        </span>
      </li>
    </ul>
    <p class="text-[11px] text-faint">
      Picked up: a Claude session opened there added it. <span class="font-mono">--uninstall</span>, run in a repo, takes it off.
    </p>
  </div>
</template>
