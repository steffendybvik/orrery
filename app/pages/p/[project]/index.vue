<script setup lang="ts">
// A project's issues as a board (columns of chunks) or a list (chunks as groups of rows): `?view=`,
// keys 1 and 2. Without `?view=` it's the view last picked in this browser.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {matches, active} = useFilters()
const {view: lastView} = useLastView()

const project = computed(() => byId(route.params.project as string))
const view = computed({
    get: () => route.query.view === 'list' || route.query.view === 'board' ? route.query.view : lastView.value,
    set: v => {
        lastView.value = v
        router.replace({query: {...route.query, view: v}})
    },
})
const views = [{value: 'board' as const, label: 'Board', hint: '1'}, {value: 'list' as const, label: 'List', hint: '2'}]

const chunks = computed(() => {
    const all = project.value?.board.chunks ?? []
    if (!active.value) return all
    return all.map(c => ({...c, tasks: filterTree(c.tasks, matches)})).filter(c => c.tasks.length)
})

useHead(() => ({title: project.value ? `${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <ProjectTabs :project="project" />
      <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] text-faint ring-1 ring-line">{{ project.key }}</span>
      <ProgressRing :counts="project.board.counts" class="hidden sm:inline-flex" />
      <span v-if="project.description" class="hidden min-w-0 truncate text-xs text-faint lg:inline">{{ project.description }}</span>
    </template>
    <template #actions>
      <SegmentedControl v-if="project" v-model="view" :options="views">
        <template #icon="{value}">
          <svg v-if="value === 'board'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg>
          <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
        </template>
      </SegmentedControl>
      <FilterBar />
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1" :class="view === 'list' ? 'overflow-y-auto' : 'overflow-hidden'">
    <template v-if="project">
      <div v-if="!project.board.chunks.length" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex flex-col gap-2">
          <p>{{ project.name }} has no chunks or issues yet.</p>
          <p class="font-mono text-xs text-faint">POST /api/projects/{{ project.id }}/chunks</p>
        </div>
      </div>
      <div v-else-if="!chunks.length" class="grid place-items-center px-4 py-24 text-sm text-muted">No issue matches the filters.</div>
      <BoardView v-else-if="view === 'board'" :chunks="chunks" :project="project.id" />
      <ListView v-else :chunks="chunks" :project="project.id" />
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
      No project “{{ route.params.project }}”. <NuxtLink to="/now" class="ml-1 text-fg underline">Go to Now</NuxtLink>
    </div>
  </div>
</template>
