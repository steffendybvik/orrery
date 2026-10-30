<script setup lang="ts">
// The launchers running code older than this orrery, on the Sessions page (ORR-434). One that says its version restarts
// itself on the new code once it has no session running, as soon as orrery serves that code or, from a checkout, once
// that's updated; one too old to say needs restarting by hand, which installing it again does.
import {launcherInstall} from '#shared/connect'
import {olderVersion} from '#shared/version'
import type {LaunchState} from '~/composables/useLaunchState'

const {launchers} = useRoadmaps()
const {ordered} = useProjectOrder()
const {version} = useRuntimeConfig().public
const install = launcherInstall(useRequestURL().origin)
/** Each project with a launcher behind, and the versions they run (`''` for one too old to say). */
const behind = ref<{id: string, name: string, versions: string[]}[]>([])
async function ask() {
    const states = await Promise.all(ordered.value.map(async p => ({p, state: await $fetch<LaunchState>(`/api/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)})))
    behind.value = states
        .map(({p, state}) => ({id: p.id, name: p.name, versions: [...new Set((state?.versions ?? []).filter(v => olderVersion(v || undefined, String(version))))]}))
        .filter(b => b.versions.length)
}
// Asked again as launchers come and go: one restarting on new code goes, then connects again.
watch([() => ordered.value.length, launchers], ask, {immediate: true})
const unsaid = computed(() => behind.value.some(b => b.versions.includes('')))
</script>

<template>
  <div v-if="behind.length" class="flex flex-col gap-2 rounded-xl bg-well p-3 text-xs leading-relaxed text-muted ring-1 ring-line">
    <p v-for="b in behind" :key="b.id">
      <span class="font-medium text-fg">The launcher for {{ b.name }} runs {{ b.versions.map(v => v || 'an older version').join(' and ') }}</span>,
      older than this orrery ({{ version }}).
    </p>
    <p>
      It restarts itself on the new code once it has no session running. One running from a checkout needs that updated first
      (<span class="font-mono">git pull</span>).<template v-if="unsaid"> One from before 1.0.0-rc.10 can't: install it again once, which restarts it and stops the sessions it's running.</template>
    </p>
    <CopyBlock v-if="unsaid" title="In the repo, run" :text="install" />
  </div>
</template>
