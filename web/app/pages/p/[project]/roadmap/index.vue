<script setup lang="ts">
// A project's roadmap: its chunks as cards in the columns their issues put them in, started first, and
// a button to start a new one.
const route = useRoute()
const {byId, ready} = useRoadmaps()
const {matches, active} = useFilters()

const project = computed(() => byId(route.params.project as string))
const chunks = computed(() => {
    const all = project.value?.board.chunks ?? []
    if (!active.value) return all
    return all.map(c => ({...c, tasks: filterTree(c.tasks, matches)})).filter(c => c.tasks.length)
})

useHead(() => ({title: project.value ? `Roadmap · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <ProgressRing :kinds="project.board.kinds" class="max-sm:hidden" />
    </template>
  </PageHeader>

  <ViewToolbar v-if="project">
    <span class="text-xs text-faint">Chunks in the column their issues put them in</span>
    <template #end>
      <FilterBar />
      <button type="button" class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs whitespace-nowrap font-medium text-white hover:opacity-90" @click="useNewChunk().open(project.id)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New chunk
      </button>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-hidden">
    <template v-if="project">
      <div v-if="!project.board.chunks.length" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex flex-col items-center gap-3">
          <p>{{ project.name }} has no chunks yet.</p>
          <button type="button" class="h-7 rounded-md px-2.5 text-xs text-fg ring-1 ring-line hover:bg-hover" @click="useNewChunk().open(project.id)">New chunk</button>
        </div>
      </div>
      <div v-else-if="!chunks.length" class="grid place-items-center px-4 py-24 text-sm text-muted">No chunk has an issue that matches the filters.</div>
      <BoardView v-else :chunks="chunks" :project="project.id" />
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
