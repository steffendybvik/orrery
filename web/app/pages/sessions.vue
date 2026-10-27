<script setup lang="ts">
import type {SessionWork} from '#shared/roadmap'
import type {Heading} from '~/utils/markdown'

// Every Claude session, in one place, by project: what each is doing, what it's on and was last sent, with its
// actions and a message box (SessionCard). A sidebar row opens its session (`#session-<id>`), lit up for a moment.
// Start session starts one on any project, or several; Message sessions says one thing to all of them (idle ones by default). Above them, whether Orrery may start sessions and how it does; below, what sessions hear and the
// presets to start one with.
useHead({title: 'Sessions · Orrery'})
const route = useRoute()
const {projects, ready, sessions, signals} = useRoadmaps()
const {ordered} = useProjectOrder()
const {open} = useStartSession()
const messaging = ref(false)

// Each project with sessions. A session that hears several projects is listed once, under its own.
const groups = computed(() => ordered.value
    .map(project => ({project, sessions: (sessions.value[project.id] ?? []).filter(s => s.project === project.id)}))
    .filter(g => g.sessions.length))
const count = computed(() => groups.value.reduce((n, g) => n + g.sessions.length, 0))

// The contents beside the page on a wide screen, as on App settings: the settings, and each project's sessions.
const scroller = ref<HTMLElement | null>(null)
const headings = computed<Heading[]>(() => [
    {id: 'starts', text: 'Starting sessions', level: 2},
    ...groups.value.map(g => ({id: `sessions-${g.project.id}`, text: g.project.name, level: 3 as const})),
    {id: 'hear', text: 'What sessions hear', level: 2},
    {id: 'presets', text: 'Presets', level: 2},
])

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
    <span class="truncate text-xs text-muted">{{ count ? `${count} ${count === 1 ? 'session' : 'sessions'}` : 'No sessions right now' }}</span>
    <template #end>
      <UiButton class="shrink-0" :disabled="!count" @click="messaging = true">Message sessions</UiButton>
      <UiButton variant="primary" class="shrink-0" @click="open()">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Start session
      </UiButton>
    </template>
  </ViewToolbar>

  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-6 sm:px-8">
    <div class="flex min-w-0 max-w-4xl flex-1 flex-col gap-6">
      <section id="starts" class="flex scroll-mt-14 flex-col gap-2">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Starting sessions</h2>
          <p class="text-xs text-muted">
            Orrery can start Claude sessions itself, with no terminal: when your work finds nobody listening, or when you press
            Start session. It does so for any project whose repo has its launcher installed.
          </p>
        </header>
        <SessionStarts />
        <StartingSessionsGuide />
      </section>
      <p v-if="ready && !groups.length" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No Claude sessions right now.
        <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="open()">Start one</button>,
        or open Claude in a <NuxtLink to="/connect" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">connected</NuxtLink> repo.
      </p>
      <section v-for="group in groups" :id="`sessions-${group.project.id}`" :key="group.project.id" class="flex scroll-mt-14 flex-col gap-3">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NuxtLink :to="`/p/${group.project.id}`" class="flex min-w-0 items-center gap-2 hover:text-accent-600 dark:hover:text-accent-400">
            <ProjectIcon v-if="group.project.icon && heroicon(group.project.icon)" :icon="group.project.icon" :color="group.project.icon_color" class="size-3.5" />
            <h2 class="truncate text-[15px] font-semibold">{{ group.project.name }}</h2>
          </NuxtLink>
          <span class="font-mono text-[11px] text-faint">{{ group.sessions.length }}</span>
          <StartSession :project="group.project" class="ml-auto" />
        </header>
        <ul class="flex flex-col gap-3">
          <SessionCard
              v-for="session in group.sessions"
              :key="session.id"
              :session="session"
              :project="group.project.id"
              :work="work[group.project.id]?.[session.id]"
              :lit="lit === session.id"
          />
        </ul>
      </section>
      <section id="hear" class="flex scroll-mt-14 flex-col gap-2 border-t border-line pt-6">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">What sessions hear</h2>
          <p class="text-xs text-muted">
            The message a Claude session gets when you ask it to focus on an issue or work through a chunk, for every project
            (a project can have its own on its Settings tab). Sessions started before a change hear it once they restart.
          </p>
        </header>
        <FocusPrompts />
      </section>
      <section id="presets" class="flex scroll-mt-14 flex-col gap-2 border-t border-line pt-6">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Presets</h2>
          <p class="text-xs text-muted">
            Saved context to give a session as you start it, for sessions on any project (a project can have its own on its
            Settings tab). Tick any number in Start session; the session gets their text with every signal, and again after a clear.
          </p>
        </header>
        <PresetSettings />
      </section>
    </div>
    <aside class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
  </div>
  <MessageSessionsDialog :open="messaging" @close="messaging = false" />
</template>
