<script setup lang="ts">
import type {Issue} from '#shared/roadmap'

// Every issue being worked on (Doing) or up now (Now) in every project, by project. A parent
// stands for its sub-issues, so nothing shows twice.
useHead({title: 'Now · Orrery'})
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {matches, active} = useFilters()

const groups = computed(() => ordered.value.map(project => {
    const issues = project.board.chunks.flatMap(chunk => chunk.tasks
        .filter(t => t.column === 'doing' || t.column === 'now')
        .map(issue => ({issue: active.value ? {...issue, tasks: filterTree(issue.tasks, matches)} : issue, chunk: chunk.title})))
        .filter(({issue}) => !active.value || matches(issue) || issue.tasks.length)
        .sort((a, b) => Number(a.issue.column === 'now') - Number(b.issue.column === 'now'))
    return {project, issues, doing: issues.filter(i => i.issue.column === 'doing').length}
}).filter(g => g.issues.length))

const count = (issues: {issue: Issue}[]) => issues.length
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" /></svg>
    <h1 class="truncate text-sm font-medium">Now across projects</h1>
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
          <span class="font-mono text-[11px] text-faint">{{ count(group.issues) }}</span>
          <span v-if="group.doing" class="text-xs text-accent-600 dark:text-accent-400">{{ group.doing }} doing</span>
        </NuxtLink>
        <IssueRow v-for="{issue, chunk} in group.issues" :key="issue.id" :issue="issue" :project="group.project.id" :chunk="chunk" nested />
      </section>
      <div v-if="ready && projects.length && !groups.length" class="grid place-items-center px-4 py-24 text-center">
        <p class="text-sm text-muted">{{ active ? 'No issue in Doing or Now matches the filters.' : 'Nothing in Doing or Now.' }}</p>
      </div>
    </template>
  </div>
</template>
