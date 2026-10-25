<script setup lang="ts">
// Every open issue assigned to the owner in every project, sub-issues included, by project: what
// waits on them (proposals first) and what they took on.
useHead({title: 'My issues · Orrery'})
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {matches} = useFilters()
const {name: owner, load} = useOwner()
onMounted(load)

const groups = computed(() => ordered.value
    .map(project => ({project, issues: myIssues(project, owner.value).filter(({issue}) => matches(issue))}))
    .filter(g => g.issues.length))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
    <h1 class="truncate text-sm font-medium">My issues</h1>
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
        <p class="text-sm text-muted">Nothing on your plate.</p>
        <p class="text-xs text-faint">Issues assigned to you show here until they're done: proposals and agents' questions land here on their own.</p>
      </div>
    </template>
  </div>
</template>
