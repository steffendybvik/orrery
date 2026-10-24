<script setup lang="ts">
// Every open urgent (P0) issue in every project, sub-issues included, by project.
useHead({title: 'Urgent · Orrery'})
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {matches} = useFilters()

const groups = computed(() => ordered.value
    .map(project => ({project, issues: urgentIssues(project).filter(({issue}) => matches(issue))}))
    .filter(g => g.issues.length))
</script>

<template>
  <PageHeader>
    <PriorityIcon priority="P0" :size="16" />
    <h1 class="truncate text-sm font-medium">Urgent across projects</h1>
  </PageHeader>

  <ViewToolbar>
    <template #end><FilterBar /></template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <template v-else>
      <section v-for="group in groups" :key="group.project.id">
        <NuxtLink :to="`/p/${group.project.id}`" class="sticky top-0 z-10 flex h-9 items-center gap-2.5 border-b border-line bg-panel/90 px-3 backdrop-blur hover:bg-hover">
          <ProgressRing :counts="group.project.board.counts" bare :size="14" />
          <h2 class="text-[13px] font-medium">{{ group.project.name }}</h2>
          <span class="font-mono text-[11px] text-faint">{{ group.issues.length }}</span>
        </NuxtLink>
        <IssueRow v-for="{issue, chunk} in group.issues" :key="issue.id" :issue="issue" :project="group.project.id" :chunk="chunk" />
      </section>
      <div v-if="ready && projects.length && !groups.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
        <p class="text-sm text-muted">Nothing urgent. Lovely.</p>
        <p class="text-xs text-faint">Issues with priority <span class="font-mono">P0</span> show here until they're done.</p>
      </div>
    </template>
  </div>
</template>
