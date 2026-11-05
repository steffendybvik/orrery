<script setup lang="ts">
import type {Project} from '#shared/roadmap'
import {listable} from '#shared/roadmap'
import {PROJECT_PLACES, type ProjectPlace} from '~/composables/useProjectOrder'

// Every project on one page (ORR-863), hidden ones too, so the sidebar can stay short and none is lost: a row each with
// what's open and started, its sessions and its current release, and where the sidebar lists it (App settings →
// Projects, ORR-836: the same state, not a second one). A search and All / Starred / Hidden keep a long list short;
// `?show=` and `?q=` keep them in the address.
useHead({title: 'Projects · orrery'})
const route = useRoute()
const router = useRouter()
const {projects, ready, sessions} = useRoadmaps()
const {ordered, isHidden, placeOf, place} = useProjectOrder()
const newProject = useState('new-project', () => false)

type Show = 'all' | 'starred' | 'hidden'
const SHOWS: {value: Show, label: string}[] = [{value: 'all', label: 'All'}, {value: 'starred', label: 'Starred'}, {value: 'hidden', label: 'Hidden'}]
const show = computed<Show>({
    get: () => SHOWS.some(s => s.value === route.query.show) ? route.query.show as Show : 'all',
    set: next => router.replace({query: {...route.query, show: next === 'all' ? undefined : next}}),
})
const query = computed({
    get: () => String(route.query.q ?? ''),
    set: next => router.replace({query: {...route.query, q: next.trim() ? next : undefined}}),
})

const matches = (project: Project, words: string[]) => {
    const text = `${project.name} ${project.key} ${project.id} ${project.description ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
}
const rows = computed(() => {
    const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
    return ordered.value
        .filter(p => show.value === 'all' || placeOf(p.id) === show.value)
        .filter(p => matches(p, words))
})
const counts = computed(() => ({
    all: projects.value.length,
    starred: ordered.value.filter(p => placeOf(p.id) === 'starred').length,
    hidden: ordered.value.filter(p => isHidden(p.id)).length,
}))

/** Its issues not done yet, of those it has committed to (canceled ones left out). */
const openCount = (project: Project) => progress(project.board.kinds).total - project.board.kinds.done
/** Its sessions working or waiting on it now. */
const running = (project: Project) => (sessions.value[project.id] ?? [])
    .filter(s => s.project === project.id && listable(s) && (s.state === 'working' || s.state === 'waiting')).length
/** The release it's on: the first being prepared, else the last one shipped. */
const currentRelease = (project: Project) => {
    if (project.release_mode === 'none') return null
    return project.releases.find(r => !r.shipped_on) ?? project.releases.find(r => r.shipped_on) ?? null
}

const failed = ref('')
async function placeProject(id: string, as: ProjectPlace) {
    failed.value = ''
    try {
        await place(id, as)
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1.5" /><rect x="14" y="4" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
    <h1 class="truncate text-sm font-medium">Projects</h1>
  </PageHeader>

  <ViewToolbar>
    <SegmentedControl v-model="show" :options="SHOWS.map(s => ({...s, label: `${s.label} ${counts[s.value]}`}))" aria-label="Which projects" />
    <template #end>
      <label class="group flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-well px-2 ring-1 ring-line focus-within:ring-accent-500/50 sm:w-56 sm:flex-none">
        <svg class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
            v-model="query"
            type="search"
            placeholder="Find a project"
            aria-label="Find a project"
            class="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
        >
      </label>
      <UiButton size="sm" class="shrink-0" @click="newProject = true">New project</UiButton>
    </template>
  </ViewToolbar>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <UiLoading v-else-if="!ready" />
    <div v-else class="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-6">
      <ul v-if="rows.length" class="flex flex-col divide-y divide-line rounded-xl ring-1 ring-line dark:bg-panel" aria-label="Projects" data-testid="projects-list">
        <li v-for="project in rows" :key="project.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
          <NuxtLink :to="`/p/${project.id}`" class="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
            <span class="flex min-w-0 items-center gap-2 text-[13px] font-medium hover:underline" :class="isHidden(project.id) ? 'text-muted' : 'text-fg'">
              <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.icon_color" class="size-3.5" />
              <ProgressRing v-else :kinds="project.board.kinds" bare :size="14" />
              <span class="truncate">{{ project.name }}</span>
              <span class="font-mono text-[11px] font-normal text-faint">{{ project.key }}</span>
            </span>
            <span class="flex flex-wrap gap-x-3 pl-5.5 text-xs text-muted">
              <span>{{ openCount(project) }} open</span>
              <span v-if="project.board.kinds.started" class="text-accent-700 dark:text-accent-300">{{ project.board.kinds.started }} in progress</span>
              <span v-if="running(project)">{{ running(project) }} session{{ running(project) === 1 ? '' : 's' }} on it</span>
              <span v-if="currentRelease(project)" class="font-mono">{{ currentRelease(project)?.version }}<template v-if="!currentRelease(project)?.shipped_on"> (preparing)</template></span>
            </span>
          </NuxtLink>
          <SegmentedControl
              :model-value="placeOf(project.id)"
              :options="PROJECT_PLACES"
              :aria-label="`Where the sidebar lists ${project.name}`"
              @update:model-value="placeProject(project.id, $event)"
          />
        </li>
      </ul>
      <p v-else class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted">
        <template v-if="query">No project matches “{{ query }}”.</template>
        <template v-else-if="show === 'starred'">No project is starred. Star the ones you're on to keep them at the top of the sidebar.</template>
        <template v-else>No project is hidden.</template>
      </p>
      <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    </div>
  </div>
</template>
