<script setup lang="ts">
// A project's issues as a list (rows grouped by status or by chunk) or a board (issue cards in their
// columns): `?view=`, keys 1 and 2. Without `?view=` it's the view last picked in this browser.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {matches, active} = useFilters()
const {view: lastView, group} = useLastView()

const project = computed(() => byId(route.params.project as string))
const {unseenIn, seeAll} = useUnseen()
const view = computed({
    get: () => route.query.view === 'list' || route.query.view === 'board' ? route.query.view : lastView.value,
    set: v => {
        lastView.value = v
        router.replace({query: {...route.query, view: v}})
    },
})
const views = [{value: 'list' as const, label: 'List', hint: '1'}, {value: 'board' as const, label: 'Board', hint: '2'}]
const groupings = [{value: 'status' as const, label: 'Status'}, {value: 'chunk' as const, label: 'Chunk'}]

const chunks = computed(() => {
    const all = project.value?.board.chunks ?? []
    if (!active.value) return all
    return all.map(c => ({...c, tasks: filterTree(c.tasks, matches)})).filter(c => c.tasks.length)
})

useHead(() => ({title: project.value ? `${project.value.name} · Orrery` : 'Orrery'}))

// Links from before issues had pages (`?issue=MOT-5`) go to the issue's page.
if (typeof route.query.issue === 'string') navigateTo(`/p/${route.params.project}/issues/${encodeURIComponent(route.query.issue)}`, {replace: true})

// Back from an issue, the row it was opened from has the focus again, so j/k carry on from there.
const {last} = useIssueLink()
onMounted(() => nextTick(() => {
    const [p, id] = last.value?.split('/') ?? []
    if (p !== project.value?.id || !id) return
    const row = document.querySelector<HTMLElement>(`main [data-issue="${CSS.escape(id)}"]`)
    row?.focus({preventScroll: true})
    row?.scrollIntoView({block: 'center'})
}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <span class="rounded bg-well px-1.5 py-px font-mono text-[10px] text-faint ring-1 ring-line">{{ project.key }}</span>
      <ProgressRing :kinds="project.board.kinds" class="max-sm:hidden" />
      <span v-if="project.description" class="hidden min-w-0 truncate text-xs text-faint lg:inline">{{ project.description }}</span>
    </template>
    <h1 v-else-if="ready" class="truncate text-sm font-medium">Not found</h1>
  </PageHeader>

  <ViewToolbar v-if="project">
    <SegmentedControl v-model="view" :options="views">
      <template #icon="{value}">
        <svg v-if="value === 'board'" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></svg>
        <svg v-else class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>
      </template>
    </SegmentedControl>
    <div v-if="view === 'list'" class="flex items-center gap-1.5">
      <span class="label">Group</span>
      <SegmentedControl v-model="group" :options="groupings" />
    </div>
    <template #end>
      <UiButton
          v-if="unseenIn(project)"
          class="shrink-0"
          title="Clear the dots on what changed since you last looked"
          @click="seeAll(project)"
      ><span class="unseen-dot" />Mark {{ unseenIn(project) }} seen</UiButton>
      <FilterBar />
      <UiButton variant="primary" class="shrink-0" title="New issue (c)" @click="useNewIssue().open(project.id)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New issue
      </UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1" :class="view === 'list' ? 'overflow-y-auto' : 'overflow-hidden'">
    <template v-if="project">
      <div v-if="!project.board.chunks.length" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex flex-col gap-2">
          <p>{{ project.name }} has no chunks or issues yet.</p>
          <p class="font-mono text-xs text-faint">POST /api/projects/{{ project.id }}/chunks</p>
        </div>
      </div>
      <div v-else-if="!chunks.length" class="grid place-items-center px-4 py-24 text-sm text-muted">No issue matches the filters.</div>
      <IssueBoard v-else-if="view === 'board'" :chunks="chunks" :project="project.id" />
      <ListView v-else :chunks="chunks" :project="project.id" :group="group" />
    </template>
    <NotFound v-else-if="ready" reason="It may have been renamed or deleted." to="/now" back="Go to Now">No project “{{ route.params.project }}”</NotFound>
  </div>
</template>
