<script setup lang="ts">
import type {SessionWork} from '#shared/roadmap'
import {launcherInstall} from '#shared/connect'
import {TERMINALS, listable, withoutChannel} from '#shared/roadmap'
import {areaId, permissionAreas} from '#shared/permissions'
import type {Heading} from '~/utils/markdown'

// Every Claude session, in one place, by project: what each is doing, what it's on and was last sent, with its
// actions and a message box (SessionCard). A sidebar row opens its session (`#session-<id>`), lit up for a moment.
// Start session starts one on any project, or several; Message sessions says one thing to all of them (idle ones by default).
// Three tabs keep them apart: Sessions, what's running; Setup (`?tab=setup`, or a link to one of its sections): first the
// launcher's install command, always in view (ORR-473; once, with repos picked up after, ORR-600), with whether orrery may start sessions
// and how, then the presets to start one with, and what sessions hear;
// presets and what they hear for every project or, picked in For, one project's own; and Permissions
// (`?tab=permissions`), what each kind of session may do, read-only (ORR-459).
useHead({title: 'Sessions · orrery'})
const route = useRoute()
const {projects, ready, sessions, signals} = useRoadmaps()
const {ordered} = useProjectOrder()
const {open} = useStartSession()
// Which terminal Watch opens, under Setup: it's about the sessions orrery starts, so it lives with them.
const {settings, save} = useAppSettings()
const {all: messaging} = useMessageSessions()
// Whose session settings the two sections below show: the orrery's (every project), or one project's own.
const scope = ref('')
const scoped = computed(() => projects.value.find(p => p.id === scope.value))
const scopeOptions = computed(() => [{value: '', label: 'Every project'}, ...ordered.value.map(p => ({value: p.id, label: p.name}))])
const terminalOptions = Object.entries(TERMINALS).map(([value, label]) => ({value, label}))
const install = launcherInstall(useRequestURL().origin)

// A session that hears several projects spans them (heardBy): it's listed once, on top under Across projects, and in
// each project it hears that has sessions of its own as a line saying so (`via`).
const known = (project: string) => (sessions.value[project] ?? []).filter(s => s.project === project)
const own = (project: string) => known(project).filter(listable)
const spanning = computed(() => ordered.value.flatMap(p => own(p.id).filter(s => heardBy(s, projects.value).spans)))
// Each project with sessions of its own.
const groups = computed(() => ordered.value
    .map(project => ({
        project,
        sessions: own(project.id).filter(s => !heardBy(s, projects.value).spans),
        via: spanning.value.filter(s => heardBy(s, projects.value).ids.includes(project.id)),
    }))
    .filter(g => g.sessions.length))
// With none, the toolbar says nothing and offers no Message sessions: the empty state below says it once (ORR-555).
const count = computed(() => spanning.value.length + groups.value.reduce((n, g) => n + g.sessions.length, 0))
// What takes the place of a session with no channel: a line per project, on what to do about it (ORR-716).
const unheard = computed(() => ordered.value.map(project => ({project, sessions: withoutChannel(known(project.id))})).filter(u => u.sessions.length))

const router = useRouter()
type Tab = 'sessions' | 'setup' | 'permissions'
const SETUP = ['#presets', '#starts', '#watch', '#hear']
const tabs = [{value: 'sessions' as const, label: 'Sessions'}, {value: 'setup' as const, label: 'Setup'}, {value: 'permissions' as const, label: 'Permissions'}]
const tab = computed<Tab>({
    get: () => route.query.tab === 'setup' || SETUP.includes(route.hash) ? 'setup' : route.query.tab === 'permissions' ? 'permissions' : 'sessions',
    set: next => router.replace({query: {...route.query, tab: next === 'sessions' ? undefined : next}, hash: ''}),
})

// The contents beside the page on a wide screen, as on App settings: each project's sessions, or the setup's sections.
const scroller = ref<HTMLElement | null>(null)
const headings = computed<Heading[]>(() => tab.value === 'permissions'
    ? permissionAreas().map(area => ({id: areaId(area), text: area, level: 2 as const}))
    : tab.value === 'sessions'
    ? [
        ...spanning.value.length ? [{id: 'sessions-across', text: 'Across projects', level: 2 as const}] : [],
        ...groups.value.map(g => ({id: `sessions-${g.project.id}`, text: g.project.name, level: 2 as const})),
    ]
    : [
        {id: 'starts', text: 'Starting sessions', level: 2},
        {id: 'presets', text: 'Presets', level: 2},
        {id: 'watch', text: 'Watching sessions', level: 2},
        {id: 'hear', text: 'What sessions hear', level: 2},
    ])

// What each session is on, by its own project, asked again whenever that project's sessions change, or a signal to them
// is sent or delivered (so Last sent keeps up).
const work = ref<Record<string, Record<string, SessionWork>>>({})
const lastSignal = (project: string) => signals.value.find(s => s.project === project)
const homes = computed(() => ordered.value.filter(p => own(p.id).length).map(p => p.id))
watch(() => homes.value.map(p => `${p}:${own(p).map(s => `${s.id}/${s.state}`).join(',')}:${lastSignal(p)?.id ?? ''}/${lastSignal(p)?.delivered_to.length ?? 0}`).join('|'), () => {
    if (!homes.value.length) return
    // One call for them all (ORR-442), not one per project.
    apiFetch<Record<string, Record<string, SessionWork>>>('/sessions/work', {query: {projects: homes.value.join(',')}})
        .then(found => work.value = {...work.value, ...found})
        .catch(() => {})
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
    <SegmentedControl v-model="tab" :options="tabs" />
    <span v-if="count" class="truncate text-xs text-muted">{{ `${count} ${count === 1 ? 'session' : 'sessions'}` }}</span>
    <template #end>
      <UiButton v-if="count" class="shrink-0" @click="messaging = true">Message sessions</UiButton>
      <UiButton variant="primary" class="shrink-0" @click="open()">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Start session
      </UiButton>
    </template>
  </ViewToolbar>

  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-6 sm:px-8">
    <div v-if="tab === 'setup'" class="flex min-w-0 max-w-4xl flex-1 flex-col gap-6">
      <section id="starts" class="flex scroll-mt-14 flex-col gap-2">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Starting sessions</h2>
          <p class="text-xs text-muted">
            orrery can start sessions itself, with no terminal: when your work finds nobody listening, or when you press
            Start session. It does so for any project whose repo the launcher serves.
          </p>
        </header>
        <CopyBlock title="Install the launcher once: run" :text="install" hint="Anywhere, it installs the launcher; in a project's repo, it adds that project too. From then on a Claude session opened in a repo adds it (--no-pick-up turns that off), and --uninstall in a repo takes it off and keeps it off. Adding a repo leaves the running sessions alone." />
        <SessionStarts />
        <LauncherRepos />
        <PickNextSetting />
        <StartingSessionsGuide />
      </section>
      <section id="presets" class="flex scroll-mt-14 flex-col gap-2 border-t border-line pt-6">
        <header class="flex flex-col gap-0.5">
          <div class="flex items-center gap-3">
            <h2 class="text-[15px] font-semibold text-fg">Presets</h2>
            <PropertyPicker v-model="scope" :options="scopeOptions" label="Presets, for" placeholder="Find a project…" field small>
              <span class="truncate">{{ scopeOptions.find(o => o.value === scope)?.label ?? scope }}</span>
            </PropertyPicker>
          </div>
          <p class="text-xs text-muted">
            Saved context to give a session as you start it, for sessions on any project or, picked here, one project's own.
            Tick any number in Start session; the session gets their text with every signal, and again after a clear.
          </p>
        </header>
        <PresetSettings :key="scope" :project="scoped" />
      </section>
      <section id="watch" class="flex scroll-mt-14 flex-col gap-2 border-t border-line pt-6">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">Watching sessions</h2>
          <p class="text-xs text-muted">
            Watch on a session orrery started opens a terminal attached to it, on the machine its launcher runs on, in this app
            (on Linux, the system's own terminal).
          </p>
        </header>
        <PropertyPicker
            :model-value="settings.terminal"
            :options="terminalOptions"
            label="Terminal app"
            field
            class="self-start"
            @update:model-value="save({terminal: $event as keyof typeof TERMINALS})"
        >
          <span class="w-40 truncate">{{ TERMINALS[settings.terminal] }}</span>
        </PropertyPicker>
      </section>
      <section id="hear" class="flex scroll-mt-14 flex-col gap-2 border-t border-line pt-6">
        <header class="flex flex-col gap-0.5">
          <div class="flex items-center gap-3">
            <h2 class="text-[15px] font-semibold text-fg">What sessions hear</h2>
            <PropertyPicker v-model="scope" :options="scopeOptions" label="What sessions hear, for" placeholder="Find a project…" field small>
              <span class="truncate">{{ scopeOptions.find(o => o.value === scope)?.label ?? scope }}</span>
            </PropertyPicker>
          </div>
          <p class="text-xs text-muted">
            The message a session gets when you ask it to focus on an issue or work through a chunk. For one project, its
            own templates (empty follows every project's) and instructions. Sessions started before a change hear it once they restart.
          </p>
        </header>
        <FocusPrompts :key="scope" :project="scoped" />
      </section>
    </div>
    <SessionPermissions v-else-if="tab === 'permissions'" class="min-w-0 max-w-4xl flex-1" />
    <div v-else class="flex min-w-0 max-w-4xl flex-1 flex-col gap-6">
      <LaunchersBehind />
      <ul v-if="unheard.length" class="flex flex-col gap-1">
        <li v-for="u in unheard" :key="u.project.id"><NoChannelHint :sessions="u.sessions" :project="u.project.id" :where="`on ${u.project.name}`" /></li>
      </ul>
      <p v-if="ready && !count" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No sessions right now.
        <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="open()">Start one</button>,
        or run <span class="font-mono">claude</span> in a <NuxtLink to="/connect" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">connected</NuxtLink> repo.
        orrery can start them for you too, set up under <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="tab = 'setup'">Setup</button>.
      </p>
      <section v-if="spanning.length" id="sessions-across" class="flex scroll-mt-14 flex-col gap-3">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 class="text-[15px] font-semibold">Across projects</h2>
          <span class="font-mono text-[11px] text-faint">{{ spanning.length }}</span>
        </header>
        <ul class="flex flex-col gap-3">
          <SessionCard
              v-for="session in spanning"
              :key="session.id"
              :session="session"
              :project="session.project"
              :work="work[session.project]?.[session.id]"
              :lit="lit === session.id"
              spans
          />
        </ul>
      </section>
      <section v-for="group in groups" :id="`sessions-${group.project.id}`" :key="group.project.id" class="flex scroll-mt-14 flex-col gap-3">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NuxtLink :to="`/p/${group.project.id}`" class="flex min-w-0 items-center gap-2 hover:text-accent-600 dark:hover:text-accent-400">
            <ProjectIcon v-if="group.project.icon && heroicon(group.project.icon)" :icon="group.project.icon" :color="group.project.icon_color" class="size-3.5" />
            <h2 class="truncate text-[15px] font-semibold">{{ group.project.name }}</h2>
          </NuxtLink>
          <span class="font-mono text-[11px] text-faint">{{ group.sessions.length }}</span>
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
          <li v-for="session in group.via" :key="`via-${session.id}`" class="flex items-center gap-2 px-4 text-xs text-faint">
            <SessionDot :session="session" />
            <span>Also hears this, via <NuxtLink :to="{hash: `#session-${session.id}`}" class="text-muted underline-offset-2 hover:text-fg hover:underline">{{ session.name }}</NuxtLink> across projects</span>
          </li>
        </ul>
      </section>
    </div>
    <aside class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
  </div>
</template>
