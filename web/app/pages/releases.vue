<script setup lang="ts">
import type {TrackedRelease} from '#shared/roadmap'
import {inProjectOrder, releasesToTrack} from '#shared/roadmap'

// Every project's releases on one page (ORR-671), a card for each project that makes its own, in the sidebar's order,
// with the projects taking theirs from it: a shared release is one release, listed once, going where the first of them
// is. A card leads with those being prepared, then its latest shipped one, with the older ones folded. `?project=` keeps
// to one project, and a project sharing its releases shows the card they're on.
const route = useRoute()
const router = useRouter()
const {projects, ready, byId} = useRoadmaps()
const {ordered} = useProjectOrder()
const {cards: read, failed} = useAllReleases()
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: id ? {project: id} : {}}),
})
// Kept to one project, the tab says which, as its other tabs do.
useHead(() => ({title: ['Releases', byId(only.value)?.name, 'orrery'].filter(Boolean).join(' · ')}))
const name = (id: string) => byId(id)?.name ?? id
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...ordered.value.filter(p => p.release_mode !== 'none').map(p => ({value: p.id, label: p.name}))])
const cards = computed(() => inProjectOrder(read.value ?? [], ordered.value.map(p => p.id), c => name(c.project))
    .filter(c => !only.value || c.projects.includes(only.value))
    .map(c => ({...c, track: releasesToTrack(c.releases)})))
const count = computed(() => {
    const all = cards.value.flatMap(c => c.releases)
    const preparing = all.filter(r => !r.shipped_on).length
    return `${preparing} being prepared, ${all.length - preparing} shipped`
})
const rows = (card: typeof cards.value[number]): TrackedRelease[] => [...card.track.preparing, ...card.track.latest ? [card.track.latest] : []]
</script>

<template>
  <PageHeader>
    <SectionIcon section="releases" class="size-4 shrink-0 text-accent-fill" />
    <h1 class="truncate text-sm font-medium">Releases</h1>
  </PageHeader>

  <ViewToolbar>
    <PropertyPicker v-model="only" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === only)?.label ?? name(only) }}</span>
    </PropertyPicker>
    <span v-if="read" class="text-xs text-muted">{{ count }}</span>
    <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
  </ViewToolbar>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <UiLoading v-else-if="!read && !failed" />
    <div v-else-if="read" class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <ul v-if="cards.length" class="flex flex-col gap-4" aria-label="Projects with releases">
        <li v-for="card in cards" :key="card.project" class="overflow-hidden rounded-xl border border-line dark:bg-panel">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2" :class="{'border-b border-line': card.releases.length}">
            <NuxtLink :to="`/p/${encodeURIComponent(card.project)}/releases`" class="text-[13px] font-medium text-fg hover:underline">{{ name(card.project) }}</NuxtLink>
            <span v-if="card.projects.length > 1" class="text-xs text-muted">shared with {{ card.projects.slice(1).map(name).join(', ') }}</span>
          </div>
          <ul v-if="card.releases.length" :aria-label="`Releases of ${name(card.project)}`">
            <ReleaseTrackRow v-for="release in rows(card)" :key="release.version" :project="card.project" :release="release" />
          </ul>
          <p v-else class="px-3 py-2 text-xs text-muted">No releases yet.</p>
          <details v-if="card.track.older.length" class="border-t border-line">
            <summary class="cursor-pointer px-3 py-1.5 text-[11px] text-faint hover:text-fg">{{ card.track.older.length }} older</summary>
            <ul :aria-label="`Older releases of ${name(card.project)}`" class="border-t border-line">
              <ReleaseTrackRow v-for="release in card.track.older" :key="release.version" :project="card.project" :release="release" />
            </ul>
          </details>
        </li>
      </ul>
      <p v-else class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        <template v-if="only">
          {{ name(only) }} has no releases.
          <NuxtLink :to="`/p/${encodeURIComponent(only)}/settings#releases`" class="text-fg underline underline-offset-2">Turn them on in Settings</NuxtLink>
          when it ships versions.
        </template>
        <template v-else>No project ships releases yet. Turn them on in a project's Settings.</template>
      </p>
    </div>
  </div>
</template>
