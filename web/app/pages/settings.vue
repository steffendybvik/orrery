<script setup lang="ts">
import {TINTS, issueRef, trackerLinkOf} from '#shared/roadmap'
import type {Heading} from '~/utils/markdown'
import {PROJECT_PLACES, type ProjectPlace} from '~/composables/useProjectOrder'

// This orrery's own settings (a project's are on its Settings tab): whose it is, how issues work in every project, and
// the orrery itself: its tint, a colour the backgrounds take on, so one orrery (personal, work) looks unlike another at a
// glance, and its secrets.
useHead({title: 'App settings · orrery'})
const {settings, tintColor, save} = useAppSettings()
const {environment} = useRuntimeConfig().public
const failed = ref('')
// The settings by what they reach (ORR-285), each tab saying so: you, how issues work in every project, this orrery as
// a whole, and Advanced, the pages for looking into problems (ORR-561). A link to a section (`#tint`) opens its tab, even
// one naming the tab it used to be on (`?tab=orrery#advanced`). How sessions start and what they hear is on the Sessions page.
type Tab = 'you' | 'projects' | 'issues' | 'orrery' | 'usage' | 'advanced'
const TABS: {value: Tab, label: string, scope: string, sections: Heading[]}[] = [
    {value: 'you', label: 'You', scope: 'Who you are on this orrery, and how your issues are named outside it.', sections: [
        {id: 'name', text: 'Your name', level: 2},
        {id: 'handle', text: 'Your handle', level: 2},
        {id: 'agent', text: 'Your AI agent', level: 2},
        // Only when this orrery asks for a login (ORR-664): alone on your own machine, none of it shows.
        ...useAuth().status.value?.mode === 'on' ? [{id: 'keys', text: 'Your keys', level: 2 as const}] : [],
        {id: 'phone', text: 'Open on your phone', level: 2},
        {id: 'logins', text: 'Signed in', level: 2},
    ]},
    {value: 'projects', label: 'Projects', scope: 'Every project on this orrery, and where the sidebar lists it.', sections: [
        {id: 'projects', text: 'Projects in the sidebar', level: 2},
    ]},
    {value: 'issues', label: 'Issues', scope: "How issues work in every project on this orrery. A project's own settings are on its Settings tab.", sections: [
        {id: 'proposals', text: 'Proposals', level: 2},
        {id: 'tracker', text: 'Team tracker', level: 2},
        {id: 'statuses', text: 'Issue statuses', level: 2},
    ]},
    {value: 'orrery', label: 'This orrery', scope: 'This orrery as a whole: how it looks and the keys its agents use. How sessions start is under Sessions → Setup.', sections: [
        {id: 'tint', text: 'Background tint', level: 2},
        {id: 'people', text: 'People', level: 2},
        {id: 'secrets', text: 'Secrets', level: 2},
    ]},
    // Usage has a tab of its own (ORR-900): counting what you use is your choice, not a tool for looking into problems.
    {value: 'usage', label: 'Usage', scope: 'What you use on this orrery, counted only while you let it, to find what could go.', sections: [
        {id: 'usage', text: 'Usage', level: 2},
    ]},
    {value: 'advanced', label: 'Advanced', scope: 'For looking into problems: what orrery records, its event log, what it puts into a session\'s context, and the open pull requests on GitHub.', sections: [
        {id: 'advanced', text: 'Advanced', level: 2},
        {id: 'events', text: 'Events', level: 2},
        {id: 'context', text: 'Context', level: 2},
        {id: 'pulls', text: 'Pull requests', level: 2},
    ]},
]
const tabs = TABS.map(({value, label}) => ({value, label}))
const route = useRoute()
const router = useRouter()
const tab = computed<Tab>({
    get: () => TABS.find(t => t.sections.some(h => `#${h.id}` === route.hash))?.value ?? TABS.find(t => t.value === route.query.tab)?.value ?? 'you',
    set: next => router.replace({query: {...route.query, tab: next === 'you' ? undefined : next}, hash: ''}),
})
// An address naming a section's old tab (`?tab=orrery#advanced`) is put right, so it reads as the tab it opens.
onMounted(() => {
    if (route.query.tab && route.query.tab !== tab.value) router.replace({query: {...route.query, tab: tab.value === 'you' ? undefined : tab.value}, hash: route.hash})
})
// The sections, listed beside them on a wide screen; each section's heading is its title here.
const headings = computed(() => TABS.find(t => t.value === tab.value)?.sections ?? [])
const title = Object.fromEntries(TABS.flatMap(t => t.sections).map(h => [h.id, h.text]))
const scroller = ref<HTMLElement | null>(null)
const custom = ref('#3b82f6')
watch(tintColor, now => {
    if (now) custom.value = now
}, {immediate: true})

// The owner's name, saved on Enter or on leaving the field; Esc puts it back. Their id follows it.
const {owner, load: loadOwner, rename} = useOwner()
onMounted(loadOwner)
const ownerName = ref('')
const ownerFailed = ref('')
watch(() => owner.value?.display, now => {
    ownerName.value = owner.value?.named ? now ?? '' : ''
}, {immediate: true})
async function saveOwner() {
    const next = ownerName.value.trim()
    if (!next || next === owner.value?.display) {
        ownerName.value = owner.value?.named ? owner.value.display : ''
        return
    }
    ownerFailed.value = ''
    try {
        await rename(next)
    } catch (error) {
        ownerFailed.value = errorMessage(error)
    }
}

// Your handle in issues' references, such as your GitHub login: saved like the name; empty uses your id.
const handle = ref('')
const handleFailed = ref('')
watch(() => settings.value.handle, now => {
    handle.value = now ?? ''
}, {immediate: true})
async function saveHandle() {
    const next = handle.value.trim()
    if (next === (settings.value.handle ?? '')) return
    handleFailed.value = ''
    try {
        await save({handle: next || null})
    } catch (error) {
        handleFailed.value = errorMessage(error)
    }
}

// Where the team's tracker shows a task, so an issue's team tasks open there; saved like the name.
// A link into the tracker that isn't a task's (its team or projects page) is turned into its task link, and said so.
const tracker = ref('')
const trackerFailed = ref('')
/** The task link a pasted link was turned into, to say so until the field changes again. */
const trackerTurned = ref('')
watch(() => settings.value.tracker, now => {
    tracker.value = now ?? ''
}, {immediate: true})
async function saveTracker() {
    const typed = tracker.value.trim()
    if (typed === (settings.value.tracker ?? '')) return
    trackerFailed.value = ''
    trackerTurned.value = ''
    const next = typed ? trackerLinkOf(typed) : null
    if (typed && !next) {
        trackerFailed.value = "That link opens the same page for every task: put {id} where a task's id goes, e.g. https://tracker.example.com/issue/{id}"
        return
    }
    try {
        await save({tracker: next})
        tracker.value = next ?? ''
        if (next && next !== typed) trackerTurned.value = next
    } catch (error) {
        trackerFailed.value = errorMessage(error)
    }
}

// Whether agents keep off a proposal until you decide it; saved as it's ticked.
const proposalsFailed = ref('')
async function restrictProposals(on: boolean) {
    proposalsFailed.value = ''
    try {
        await save({restrict_proposals: on})
    } catch (error) {
        proposalsFailed.value = errorMessage(error)
    }
}

// Projects (ORR-836): each starred (first in the sidebar), as it is, or hidden (folded away under Hidden there).
const {ordered: allProjects, isHidden, placeOf, place} = useProjectOrder()
const projectsFailed = ref('')
async function placeProject(id: string, as: ProjectPlace) {
    projectsFailed.value = ''
    try {
        await place(id, as)
    } catch (error) {
        projectsFailed.value = errorMessage(error)
    }
}

// Advanced: the Events page and error notices in the bell, and what orrery does recorded as well as its errors.
const {newErrors} = useLoggedEvents()
// The open pull requests on the projects' repos, counted beside their link as the sidebar used to (ORR-565).
const {pulls, follow: followPulls} = useOpenPulls()
followPulls(120_000)
const advancedFailed = ref('')
async function setAdvanced(on: boolean) {
    advancedFailed.value = ''
    try {
        await save({advanced: on})
    } catch (error) {
        advancedFailed.value = errorMessage(error)
    }
}

async function pick(tint: string | null) {
    failed.value = ''
    try {
        await save({tint})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="settings" class="size-4 text-faint" />
    <h1 class="truncate text-sm font-medium">App settings</h1>
  </PageHeader>

  <ViewToolbar>
    <SegmentedControl v-model="tab" :options="tabs" />
  </ViewToolbar>

  <div ref="scroller" class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-8 sm:px-8">
    <div class="flex min-w-0 max-w-3xl flex-1 flex-col gap-8 [&>section+section]:border-t [&>section+section]:border-line [&>section+section]:pt-8">
      <p class="-mb-2 text-xs text-muted">{{ TABS.find(t => t.value === tab)?.scope }}</p>

      <section v-if="tab === 'you'" id="name" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.name }}</h2>
          <p class="text-xs text-muted">
            You own this orrery: what you make, no one else can delete. Your <span class="font-mono">Orrery-Actor</span> header is
            <span class="font-mono">{{ owner?.name }}</span>; renaming moves what's yours to the new one.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveOwner">
          <input
              v-model="ownerName"
              aria-label="Your name"
              maxlength="60"
              class="h-8 w-72 max-w-full field"
              @blur="saveOwner"
              @keydown.esc="ownerName = owner?.named ? owner.display : ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="ownerFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ ownerFailed }}</span>
        </form>
      </section>

      <section v-if="tab === 'you'" id="handle" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.handle }}</h2>
          <p class="text-xs text-muted">
            Says whose board an issue is on, once colleagues have boards of their own: an issue's reference is
            <span class="font-mono">{{ issueRef(handle.trim() || owner?.name || 'owner', 'ORR-1') }}</span>, for commit bodies and PR descriptions.
            Your GitHub login works well; left empty, it's your id.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveHandle">
          <input
              v-model="handle"
              aria-label="Your handle"
              :placeholder="owner?.name"
              spellcheck="false"
              maxlength="39"
              class="h-8 w-72 max-w-full field font-mono"
              @blur="saveHandle"
              @keydown.esc="handle = settings.handle ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="handleFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ handleFailed }}</span>
        </form>
      </section>

      <section v-if="tab === 'you'" id="agent" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.agent }}</h2>
          <p class="text-xs text-muted">
            The agent you work with. Getting started and Connect an agent show how to set it up. orrery starts and sends
            work to Claude Code sessions; another agent keeps the roadmap through orrery's API and MCP tools.
          </p>
        </header>
        <AgentPicker />
      </section>

      <section v-if="tab === 'you' && useAuth().status.value?.mode === 'on'" id="keys" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.keys }}</h2>
          <p class="text-xs text-muted">
            What your sessions and browsers show to prove who they are, now this orrery asks for a login.
          </p>
        </header>
        <KeySettings />
      </section>

      <section v-if="tab === 'you'" id="phone" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.phone }}</h2>
          <p class="text-xs text-muted">
            The address to open this orrery at from your phone, with a QR code to scan the first time. The code is made here, with nothing sent anywhere.
          </p>
        </header>
        <PhoneLink />
      </section>

      <section v-if="tab === 'you'" id="logins" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.logins }}</h2>
          <p class="text-xs text-muted">
            Each browser and phone signed in to this orrery. End one you've lost, and it has to sign in again.
          </p>
        </header>
        <LoginSettings />
      </section>

      <section v-if="tab === 'projects'" id="projects" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.projects }}</h2>
          <p class="text-xs text-muted">
            Star the projects you're on to keep them at the top of the sidebar, and hide the ones you're leaving for a while.
            A hidden one folds away under Hidden at the foot of the list. Its issues, sessions and schedules carry on, and its pages still open.
          </p>
        </header>
        <ul v-if="allProjects.length" class="flex flex-col divide-y divide-line rounded-xl ring-1 ring-line" data-testid="settings-projects">
          <li v-for="project in allProjects" :key="project.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
            <NuxtLink :to="`/p/${project.id}`" class="flex min-w-0 flex-1 items-center gap-2 text-[13px] hover:underline" :class="isHidden(project.id) ? 'text-muted' : 'text-fg'">
              <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.icon_color" class="size-3.5" />
              <ProgressRing v-else :kinds="project.board.kinds" bare :size="14" />
              <span class="truncate">{{ project.name }}</span>
            </NuxtLink>
            <SegmentedControl
                :model-value="placeOf(project.id)"
                :options="PROJECT_PLACES"
                :aria-label="`Where the sidebar lists ${project.name}`"
                @update:model-value="placeProject(project.id, $event)"
            />
          </li>
        </ul>
        <p v-else class="text-xs text-faint">No projects yet.</p>
        <p v-if="projectsFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ projectsFailed }}</p>
      </section>

      <section v-if="tab === 'issues'" id="proposals" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.proposals }}</h2>
          <p class="text-xs text-muted">
            A proposal isn't work until you approve it. While one waits on you, sessions can comment on it and put it up again,
            but not start it, assign it or put it in a release, so nothing gets built before you've said yes.
          </p>
        </header>
        <label class="flex items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" class="accent-accent-fill" :checked="settings.restrict_proposals" @change="restrictProposals(($event.target as HTMLInputElement).checked)">
          Keep agents off proposals until you approve them
        </label>
        <p v-if="proposalsFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ proposalsFailed }}</p>
      </section>

      <section v-if="tab === 'issues'" id="tracker" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tracker }}</h2>
          <p class="text-xs text-muted">
            This board is yours; the team's tasks live on its tracker. An issue's Team tasks link there:
            give a task's web address with <span class="font-mono">{id}</span> where its id goes.
          </p>
        </header>
        <form class="flex items-center gap-2" @submit.prevent="saveTracker">
          <input
              v-model="tracker"
              type="url"
              aria-label="Team tracker"
              placeholder="https://tracker.example.com/issue/{id}"
              spellcheck="false"
              class="h-8 w-[28rem] max-w-full field font-mono"
              @blur="saveTracker"
              @keydown.esc="tracker = settings.tracker ?? ''; ($event.target as HTMLInputElement).blur()"
          >
          <span v-if="trackerFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ trackerFailed }}</span>
        </form>
        <p v-if="trackerTurned" class="text-xs text-muted" role="status">
          Saved as a task link, with <span class="font-mono">{id}</span> where a task's id goes: <span class="font-mono text-fg">{{ trackerTurned }}</span>
        </p>
        <p v-else class="text-xs text-faint">
          For a tracker this board knows, a link to its team or projects page works too: it's saved as the link to a task.
        </p>
      </section>

      <section v-if="tab === 'issues'" id="statuses" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.statuses }}</h2>
          <p class="text-xs text-muted">
            The columns every project's issues move through. Each belongs to a kind, which is what orrery and your agents go by:
            add a status to a kind (In review, Blocked) and it counts, shows and signals like the rest of its kind.
          </p>
        </header>
        <StatusSettings />
      </section>

      <section v-if="tab === 'orrery'" id="tint" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.tint }}</h2>
          <p class="text-xs text-muted">
            Colours this orrery<template v-if="environment"> ({{ environment }})</template> so you can tell it from another at a glance. It's this orrery's own: each keeps its tint.
          </p>
        </header>
        <div class="flex flex-wrap items-center gap-2">
          <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1 transition-colors"
              :class="!settings.tint ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="!settings.tint"
              @click="pick(null)"
          >None</button>
          <button
              v-for="(color, name) in TINTS"
              :key="name"
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] capitalize ring-1 transition-colors"
              :class="settings.tint === name ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
              :aria-pressed="settings.tint === name"
              @click="pick(name)"
          >
            <span class="size-3.5 rounded-full ring-1 ring-black/10" :style="{background: color}" />
            {{ name }}
          </button>
          <label
              class="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ring-1"
              :class="settings.tint?.startsWith('#') ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line'"
          >
            <input v-model="custom" type="color" aria-label="Custom tint" class="size-5 rounded border-0 bg-transparent p-0" @change="pick(custom)">
            Custom
          </label>
        </div>
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      </section>

<section v-if="tab === 'orrery'" id="people" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.people }}</h2>
          <p class="text-xs text-muted">
            Who works on this orrery, each with their own agents. Alone, you need do nothing here.
          </p>
        </header>
        <PeopleSettings />
      </section>

            <section v-if="tab === 'orrery'" id="secrets" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.secrets }}</h2>
          <p class="text-xs text-muted">
            Keys your agents use to call outside services without ever seeing them. An agent puts
            <span class="font-mono">{{ '{' + '{secret:NAME}' + '}' }}</span> in a request, and orrery fills it in and sends it, over https, only to the hosts you allow.
            Taking a host off needs nothing more; letting a secret go somewhere new takes its value again.
          </p>
        </header>
        <SecretSettings />
      </section>

      <section v-if="tab === 'advanced'" id="advanced" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.advanced }}</h2>
          <p class="text-xs text-muted">
            orrery always keeps a log of its errors, in the server and in this page, on this machine only.
            With Advanced on, which it is unless you turn it off, it also records what it does (sessions starting and stopping,
            launchers, schedule runs, migrations) and each change to the roadmap, puts a notice in the bell for each new
            kind of error, and shows Events, Context and Pull requests in the sidebar under Schedules. They stay linked below
            either way.
          </p>
        </header>
        <label class="flex items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" class="accent-accent-fill" :checked="settings.advanced" @change="setAdvanced(($event.target as HTMLInputElement).checked)">
          Record what orrery does, tell me about new errors, and show Events, Context and Pull requests in the sidebar
        </label>
        <p v-if="advancedFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ advancedFailed }}</p>
      </section>

      <section v-if="tab === 'usage'" id="usage" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.usage }}</h2>
          <p class="text-xs text-muted">
            Which features you use, the coldest first, to find what could go. Off unless you turn it on. It counts only your
            own use (the pages you open, the tools your sessions call, and a few optional features), a number a day, on
            this machine only: nothing about what you did, and nothing sent anywhere.
          </p>
        </header>
        <UsageSettings />
      </section>

      <section v-if="tab === 'advanced'" id="events" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.events }}</h2>
          <p class="text-xs text-muted">
            orrery's event log, read like a console: what went wrong and, with Advanced on, what it did and each change to the
            roadmap, a line each.
          </p>
        </header>
        <div class="flex items-center gap-2">
          <NuxtLink to="/events" class="text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">Open the event log</NuxtLink>
          <ErrorBadge v-if="newErrors.length" :count="newErrors.length" :title="`${newErrors.length} new kind${newErrors.length === 1 ? '' : 's'} of error`" />
        </div>
      </section>

      <section v-if="tab === 'advanced'" id="context" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.context }}</h2>
          <p class="text-xs text-muted">
            What orrery puts into a session's context, part by part with its size, to see what to cut. A running session's is
            also on its card on the Sessions page while Advanced is on.
          </p>
        </header>
        <NuxtLink to="/context" class="self-start text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">See what a session is sent</NuxtLink>
      </section>

      <section v-if="tab === 'advanced'" id="pulls" class="scroll-mt-6 flex flex-col gap-3">
        <header class="flex flex-col gap-0.5">
          <h2 class="text-[15px] font-semibold text-fg">{{ title.pulls }}</h2>
          <p class="text-xs text-muted">
            Every open pull request on the projects' GitHub repos, those that need someone (conflicts, failing checks, behind
            their base) first. An issue's own show on its page.
          </p>
        </header>
        <div class="flex items-center gap-2">
          <NuxtLink to="/pulls" class="text-[13px] font-medium text-accent-700 hover:underline dark:text-accent-400">Open pull requests</NuxtLink>
          <ErrorBadge v-if="pulls?.needs" :count="pulls.needs" :title="`${pulls.needs} need${pulls.needs === 1 ? 's' : ''} someone: conflicts, failing checks or behind`" />
          <span v-else-if="pulls?.open" class="font-mono text-[11px] text-faint tabular-nums">{{ pulls.open }}</span>
          <span v-else-if="pulls && !pulls.repos.length" class="text-xs text-faint">No project has a repo on GitHub yet.</span>
        </div>
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
