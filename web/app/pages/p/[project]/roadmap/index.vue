<script setup lang="ts">
// A project's roadmap: its chunks as cards in the columns their issues put them in, started first.
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
      <ProjectTabs :project="project" />
      <ProgressRing :kinds="project.board.kinds" class="max-sm:hidden" />
    </template>
  </PageHeader>

  <ViewToolbar v-if="project">
    <span class="text-xs text-faint">Chunks in the column their issues put them in</span>
    <template #end><FilterBar /></template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-hidden">
    <template v-if="project">
      <div v-if="!project.board.chunks.length" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex flex-col gap-2">
          <p>{{ project.name }} has no chunks yet.</p>
          <p class="font-mono text-xs text-faint">POST /api/projects/{{ project.id }}/chunks</p>
        </div>
      </div>
      <div v-else-if="!chunks.length" class="grid place-items-center px-4 py-24 text-sm text-muted">No chunk has an issue that matches the filters.</div>
      <BoardView v-else :chunks="chunks" :project="project.id" />
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
