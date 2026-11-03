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

useHead(() => ({title: project.value ? `Roadmap · ${project.value.name} · orrery` : 'orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <ProgressRing :kinds="project.board.kinds" class="max-sm:hidden" />
    </template>
    <h1 v-else-if="ready" class="truncate text-sm font-medium">Not found</h1>
  </PageHeader>

  <ViewToolbar v-if="project">
    <span class="text-xs text-faint">Chunks in the column their issues put them in</span>
    <template #end>
      <FilterBar />
      <UiButton variant="primary" class="shrink-0" @click="useNewChunk().open(project.id)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New chunk
      </UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-hidden">
    <template v-if="project">
      <div v-if="!project.board.chunks.length" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex flex-col items-center gap-3">
          <p>{{ project.name }} has no chunks yet.</p>
          <UiButton @click="useNewChunk().open(project.id)">New chunk</UiButton>
        </div>
      </div>
      <div v-else-if="!chunks.length" class="grid place-items-center px-4 py-24 text-sm text-muted">No chunk has an issue that matches the filters.</div>
      <BoardView v-else :chunks="chunks" :project="project.id" />
    </template>
    <NotFound v-else-if="ready" reason="It may have been renamed or deleted." to="/mine" back="Go to My issues">No project “{{ route.params.project }}”</NotFound>
    <UiLoading v-else />
  </div>
</template>
