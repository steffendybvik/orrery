<script setup lang="ts">
// Every project's schedules, a card for each project that has any (ScheduleList), in the sidebar's order;
// `?project=` keeps to one (a project's old Schedules tab comes here that way), shown even with none. A new one is
// made on the project picked for it, or from its card.
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
const all = computed(() => Object.values(byProject.value).flat().filter(s => !only.value || s.project === only.value))
const cards = computed(() => ordered.value
    .map(project => ({project, schedules: byProject.value[project.id] ?? []}))
    .filter(c => only.value ? c.project.id === only.value : c.schedules.length))
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
    <template v-if="ordered.length && !only" #end>
      <select v-model="picked" aria-label="New schedule in" class="h-7 shrink-0 cursor-pointer rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none">
        <option value="" disabled>+ New schedule in…</option>
        <option v-for="p in ordered" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else-if="cards.length" class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <ScheduleList v-for="card in cards" :key="card.project.id" :project="card.project" :schedules="card.schedules" />
    </div>
    <p v-else-if="ready" class="px-4 py-10 text-center text-sm text-faint">Nothing scheduled on any project yet: make one with <span class="font-medium text-muted">New schedule in…</span> above.</p>
  </div>
</template>
