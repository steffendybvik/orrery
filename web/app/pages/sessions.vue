<script setup lang="ts">
import type {SessionWork} from '#shared/roadmap'

// Every Claude session, in one place, by project: what each is doing, what it's on and was last sent, with its
// actions and a message box (SessionCard). `?project=` keeps to one project; a project's old Sessions tab comes
// here that way, and a sidebar row opens its session (`#session-<id>`), lit up for a moment. Start session starts
// one on any project, and the guide says how Orrery starts them with no terminal.
useHead({title: 'Sessions · Orrery'})
const route = useRoute()
const router = useRouter()
const {projects, ready, sessions, signals} = useRoadmaps()
const {ordered} = useProjectOrder()
const {open} = useStartSession()

/** The project the page keeps to, from `?project=`; none for all. */
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: id ? {project: id} : {}, hash: route.hash}),
})
const shown = computed(() => ordered.value.filter(p => !only.value || p.id === only.value))
// Each project with sessions; the one kept to shows even with none, to say so.
const groups = computed(() => shown.value
    .map(project => ({project, sessions: sessions.value[project.id] ?? []}))
    .filter(g => g.sessions.length || g.project.id === only.value))
const count = computed(() => groups.value.reduce((n, g) => n + g.sessions.length, 0))

// What each session is on, by project, asked again whenever that project's sessions change, or a signal to them is
// sent or delivered (so Last sent keeps up).
const work = ref<Record<string, Record<string, SessionWork>>>({})
const lastSignal = (project: string) => signals.value.find(s => s.project === project)
watch(() => groups.value.map(g => `${g.project.id}:${g.sessions.map(s => `${s.id}/${s.state}`).join(',')}:${lastSignal(g.project.id)?.id ?? ''}/${lastSignal(g.project.id)?.delivered_to.length ?? 0}`).join('|'), () => {
    for (const {project, sessions: here} of groups.value) {
        if (!here.length) continue
        $fetch<Record<string, SessionWork>>(`/api/projects/${encodeURIComponent(project.id)}/sessions/work`)
            .then(found => work.value = {...work.value, [project.id]: found})
            .catch(() => {})
    }
}, {immediate: true})

// The session a link points at, scrolled to and lit up.
const lit = ref('')
async function show(hash: string) {
    const id = hash.replace(/^#session-/, '')
    if (!id || id === hash) return
    await nextTick()
    document.getElementById(`session-${id}`)?.scrollIntoView({block: 'center'})
    lit.value = id
    setTimeout(() => lit.value === id && (lit.value = ''), 1600)
}
watch(() => [route.hash, count.value] as const, ([hash]) => show(hash), {immediate: true})
</script>

<template>
  <PageHeader>
    <SectionIcon section="sessions" class="size-4 shrink-0 text-accent-500" />
    <h1 class="truncate text-sm font-medium">Sessions</h1>
  </PageHeader>

  <ViewToolbar>
    <select v-model="only" aria-label="Project" class="h-7 max-w-44 cursor-pointer truncate rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line focus:outline-none">
      <option value="">All projects</option>
      <option v-for="p in ordered" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <span class="truncate text-xs text-muted">{{ count ? `${count} ${count === 1 ? 'session' : 'sessions'}` : 'No sessions right now' }}</span>
    <template #end>
      <button type="button" class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 whitespace-nowrap text-xs font-medium text-white hover:opacity-90" @click="open(only || undefined)">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Start session
      </button>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-6 px-4 py-6 sm:px-8">
      <StartingSessionsGuide />
      <p v-if="ready && !groups.length" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No Claude sessions right now.
        <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="open()">Start one</button>,
        or open Claude in a <NuxtLink to="/connect" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">connected</NuxtLink> repo.
      </p>
      <section v-for="group in groups" :key="group.project.id" class="flex flex-col gap-3">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NuxtLink :to="`/p/${group.project.id}`" class="flex min-w-0 items-center gap-2 hover:text-accent-600 dark:hover:text-accent-400">
            <ProjectIcon v-if="group.project.icon && heroicon(group.project.icon)" :icon="group.project.icon" :color="group.project.icon_color" class="size-3.5" />
            <h2 class="truncate text-[15px] font-semibold">{{ group.project.name }}</h2>
          </NuxtLink>
          <span class="font-mono text-[11px] text-faint">{{ group.sessions.length }}</span>
          <StartSession :project="group.project" class="ml-auto" />
        </header>
        <ul v-if="group.sessions.length" class="flex flex-col gap-3">
          <SessionCard
              v-for="session in group.sessions"
              :key="session.id"
              :session="session"
              :project="group.project.id"
              :work="work[group.project.id]?.[session.id]"
              :lit="lit === session.id"
          />
        </ul>
        <p v-else class="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] leading-relaxed text-muted">
          No Claude session on {{ group.project.name }} has said hello yet.
          <NuxtLink :to="`/connect?project=${group.project.id}`" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">Connect one</NuxtLink>
          to see it here.
        </p>
      </section>
    </div>
  </div>
</template>
