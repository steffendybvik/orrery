<script setup lang="ts">
// Every project's schedules in one agenda, soonest first, each saying its project; `?project=` keeps to one (a
// project's old Schedules tab comes here that way). A new one is made on the project picked for it.
useHead({title: 'Schedules · Orrery'})
const route = useRoute()
const router = useRouter()
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {byProject, edit} = useSchedules()
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: id ? {project: id} : {}}),
})
const all = computed(() => Object.values(byProject.value).flat()
    .filter(s => !only.value || s.project === only.value)
    .sort((a, b) => (a.next_run ?? '~').localeCompare(b.next_run ?? '~')))
const active = computed(() => all.value.filter(s => s.enabled).length)

/** The project a new schedule goes on, picked from the select; it opens the dialog and resets. */
const picked = computed({
    get: () => '',
    set: (project: string) => project && edit(project),
})
</script>

<template>
  <PageHeader>
    <SectionIcon section="schedules" class="size-4 shrink-0 text-accent-500" />
    <h1 class="truncate text-sm font-medium">Schedules</h1>
  </PageHeader>

  <ViewToolbar>
    <select v-model="only" aria-label="Project" class="h-7 max-w-44 cursor-pointer truncate rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line focus:outline-none">
      <option value="">All projects</option>
      <option v-for="p in ordered" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <span class="text-xs text-muted">{{ all.length ? `${active} running, ${all.length - active} paused` : 'Nothing scheduled' }}</span>
    <template v-if="ordered.length" #end>
      <button v-if="only" type="button" class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 whitespace-nowrap text-xs font-medium text-white hover:opacity-90" @click="edit(only)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New schedule
      </button>
      <select v-else v-model="picked" aria-label="New schedule in" class="h-7 shrink-0 cursor-pointer rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none">
        <option value="" disabled>+ New schedule in…</option>
        <option v-for="p in ordered" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <ScheduleList v-else-if="all.length" :schedules="all" :projects="!only" />
    <p v-else-if="ready" class="px-4 py-10 text-center text-sm text-faint">{{ only ? 'Nothing scheduled here yet: make one with' : 'Nothing scheduled on any project yet: make one with' }} <span class="font-medium text-muted">{{ only ? 'New schedule' : 'New schedule in…' }}</span> above.</p>
  </div>
</template>
