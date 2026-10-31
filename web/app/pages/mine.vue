<script setup lang="ts">
// What waits on the owner's answer on top: every issue in any project with an agent's question they haven't
// answered, or an agent's proposal they haven't decided (`waiting`). Then every open urgent (P0) issue, whoever
// has it; then every open issue assigned to the owner, by project: what waits on them (proposals first) and what
// they took on. Sub-issues included; each issue shows once, in the first list it's in. It's home, so Getting started's
// card sits on top until it's done.
useHead({title: 'My issues · orrery'})
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {matches, shows} = useFilters()
const {name: owner, load} = useOwner()
// Whoever's logged in, or the owner with no login: a member sees what's theirs (ORR-658).
const {me: person} = usePeople()
const me = computed(() => person.value ?? owner.value)
const member = computed(() => me.value !== owner.value)
const gettingStarted = useGettingStarted()
onMounted(load)

const waiting = computed(() => ordered.value.filter(p => shows(p.id))
    .map(project => ({project, issues: allIssues(project).filter(({issue}) => issue.waiting && matches(issue) && (!member.value || issue.assignee?.toLowerCase() === me.value))}))
    .filter(g => g.issues.length))
const urgent = computed(() => ordered.value.filter(p => shows(p.id))
    .map(project => ({project, issues: urgentIssues(project).filter(({issue}) => !issue.waiting && matches(issue))}))
    .filter(g => g.issues.length))
const mine = computed(() => ordered.value.filter(p => shows(p.id))
    .map(project => ({project, issues: myIssues(project, me.value).filter(({issue}) => issue.priority !== 'P0' && !issue.waiting && matches(issue))}))
    .filter(g => g.issues.length))
// Each list's hint goes beside its label, or under it on a phone so the label keeps to one line (ORR-556).
const lists = computed(() => [
    {id: 'waiting', title: 'Waiting on you', hint: 'an agent asked for your decision or feedback: answer with a comment', groups: waiting.value},
    {id: 'urgent', title: 'Urgent', hint: 'P0 in any project, whoever has it', groups: urgent.value},
    {id: 'mine', title: 'Assigned to you', hint: '', groups: mine.value},
].filter(l => l.groups.length))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
    <h1 class="truncate text-sm font-medium">My issues</h1>
  </PageHeader>

  <ViewToolbar>
    <template #end><FilterBar /></template>
  </ViewToolbar>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <template v-else>
      <GettingStarted v-if="!gettingStarted.finished.value && !gettingStarted.hidden.value" card class="m-3 md:m-4" />
      <div v-for="(list, i) in lists" :key="list.id" :class="i > 0 && 'mt-6'">
        <h2 class="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-4 pb-2">
          <PriorityIcon v-if="list.id === 'urgent'" priority="P0" :size="14" />
          <span v-else-if="list.id === 'waiting'" class="size-2 rounded-full bg-violet-500" />
          <span class="label whitespace-nowrap">{{ list.title }}</span>
          <span v-if="list.hint" class="basis-full text-[11px] text-faint sm:basis-auto">{{ list.hint }}</span>
        </h2>
        <section v-for="group in list.groups" :key="group.project.id">
          <NuxtLink :to="`/p/${group.project.id}`" class="sticky top-0 z-10 flex h-9 items-center gap-2.5 border-y border-line bg-panel/90 px-3 backdrop-blur hover:tint">
            <ProgressRing :kinds="group.project.board.kinds" bare :size="14" />
            <h3 class="text-[13px] font-medium">{{ group.project.name }}</h3>
            <span class="font-mono text-[11px] text-faint">{{ group.issues.length }}</span>
          </NuxtLink>
          <IssueRow v-for="{issue, chunk} in group.issues" :key="issue.id" :issue="issue" :project="group.project.id" :chunk="chunk" />
        </section>
      </div>
      <div v-if="ready && projects.length && !lists.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
        <p class="text-sm text-muted">Nothing urgent, nothing on your plate.</p>
        <p class="text-xs text-faint">Urgent (<span class="font-mono">P0</span>) issues in any project, and issues assigned to you, show here until they're done: proposals and agents' questions land here on their own.</p>
      </div>
    </template>
  </div>
</template>
