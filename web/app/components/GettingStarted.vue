<script setup lang="ts">
import {launcherInstall} from '#shared/connect'
// Getting started: the steps from a new orrery to a Claude session working from it, each ticked from what the
// orrery knows (useGettingStarted), with what to do for the one you're on. As a page it's the first run (in place
// of "No projects yet", and at /getting-started); `card` is its fold-away form at the top of My issues. Opening it on a
// phone comes last, optional and out of the count (ORR-876).
defineProps<{card?: boolean}>()

const {steps, phone, checkPhone, done, current, finished, project, hide, planning, plan, WITHOUT_CLAUDE} = useGettingStarted()
// The optional last step (ORR-876): the phone's code, shown on a press, as each showing makes a sign-in link.
const showPhone = ref(false)
onMounted(checkPhone)
const pieces = useConnect(project)
const newProject = useState('new-project', () => false)
const {open: newIssue} = useNewIssue()
const demo = useDemoProject()
const router = useRouter()
const open = ref(true)
// The install line (ORR-1067), on the first open: the launcher, and orrery in Claude Code's user config for every
// folder, so a session reaches it before any repo is connected. Gone once a launcher connects.
const {launchers} = useRoadmaps()
const machineReady = computed(() => Object.values(launchers.value).some(count => count > 0))
const machineLine = launcherInstall(serverOrigin())
// The AI agent you run (ORR-1075), picked here or in App settings: the install line and the session's start line are
// Claude Code's, so another agent is shown what works without an adapter.
const {settings} = useAppSettings()
const otherAgent = computed(() => settings.value.agent === 'other')

const TEXT = [
    {title: 'You own this orrery', text: 'What you make, no one else can delete. Your name is in App settings.'},
    {title: 'Make a project', text: 'One for each app or repo. Its issues get a key of their own, like SHP-1.'},
    {title: 'Connect a folder', text: "Open a terminal in your app's folder (any folder works; an empty one to try it), run claude, and paste this. It writes the folder's .mcp.json, hooks and CLAUDE.md itself, and the step ticks once the session says hello."},
    {title: 'Start a session with the channel', text: 'So orrery can send the session work. Ticked once a session is listening.'},
    {title: 'Send it work', text: 'Make an issue and press Focus on this on its page, or ask from the Sessions page. Ticked when a session starts one.'},
]

/** What steps 3 and 4 say for an agent with no adapter (ORR-1075). */
const OTHER: Record<string, string> = {
    connect: "Open your agent in your app's folder and give it this. It reads its brief from orrery and keeps the roadmap here.",
    listen: "orrery can only send work to Claude Code sessions so far. Your agent reaches orrery through its API and MCP tools instead: Connect an agent shows how.",
}
const textOf = (i: number, key: string) => (otherAgent.value ? OTHER[key] : undefined) ?? TEXT[i]?.text

const PHONE = {title: 'Open it on your phone', text: "Scan the code with the phone's camera, at home on the same Wi-Fi. Ticked once a phone is signed in."}

async function tryDemo() {
    const id = await demo.make()
    if (id) router.push(`/p/${id}`)
}
</script>

<template>
  <section v-if="card" class="rounded-xl border border-line bg-panel" aria-label="Getting started">
    <div class="flex items-center gap-3 px-4 py-3">
      <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" :aria-expanded="open" @click="open = !open">
        <ProgressRing :kinds="{proposed: 0, backlog: 0, todo: steps.length - done, started: 0, done, canceled: 0}" bare :size="18" />
        <span class="text-[13px] font-medium text-fg">Getting started</span>
        <span class="truncate text-xs text-faint">{{ done }} of {{ steps.length }}<template v-if="!finished"> · next: {{ TEXT[current]!.title.charAt(0).toLowerCase() + TEXT[current]!.title.slice(1) }}</template></span>
        <svg class="ml-auto size-3 shrink-0 text-faint transition-transform" :class="open && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <UiButton variant="ghost" size="xs" title="Hide it; ⌘K → Getting started brings it back" @click="hide()">Hide</UiButton>
    </div>
    <ol v-if="open" class="flex flex-col gap-3 border-t border-line px-4 py-3 text-[13px] text-muted">
      <template v-for="(step, i) in steps" :key="step.key">
      <li v-if="i === WITHOUT_CLAUDE" class="text-[11px] font-medium uppercase tracking-wide text-faint">For working with agents</li>
      <li class="flex gap-3" :class="!step.done && i !== current && 'opacity-60'">
        <StepMark :done="step.done" :n="i + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="font-medium" :class="step.done ? 'text-muted line-through decoration-faint' : 'text-fg'">{{ TEXT[i]!.title }}</span>
          <template v-if="i === current && !step.done">
            <span>{{ textOf(i, step.key) }}</span>
            <UiButton v-if="step.key === 'project'" variant="primary" class="self-start" @click="newProject = true">New project</UiButton>
            <CopyBlock v-else-if="step.key === 'connect'" title="Paste into a session, in the folder" :text="pieces.prompt" />
            <CopyBlock v-else-if="step.key === 'listen' && !otherAgent" title="In the folder, start a session with" :text="pieces.launch" :hint="`An alias saves typing it: alias ${project?.id ?? 'app'}='cd /path/to/folder && ${pieces.launch}'`" />
            <UiButton v-else-if="step.key === 'work' && project" variant="primary" class="self-start" @click="newIssue(project.id)">New issue</UiButton>
            <LauncherHint v-if="step.key === 'work' && project" :project="project.id" />
          </template>
        </div>
      </li>
      </template>
      <li v-if="current >= WITHOUT_CLAUDE && !finished">
        <button type="button" class="text-xs text-accent-700 hover:underline dark:text-accent-400" @click="plan()">Just planning? You're set</button>
      </li>
      <li class="flex gap-3" data-step="phone">
        <StepMark :done="phone.done" :n="steps.length + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="font-medium" :class="phone.done ? 'text-muted line-through decoration-faint' : 'text-fg'">{{ PHONE.title }} <span class="font-normal text-faint">· optional</span></span>
          <template v-if="!phone.done">
            <span>{{ PHONE.text }}</span>
            <PhoneLink v-if="showPhone" />
            <UiButton v-else class="self-start" @click="showPhone = true">Show the code</UiButton>
          </template>
        </div>
      </li>
    </ol>
  </section>

  <div v-else class="mx-auto flex w-full max-w-xl animate-fade-up flex-col gap-6 px-4 py-14">
    <div class="flex items-center gap-3">
      <div class="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-tile-from to-tile-to shadow-lg shadow-accent-600/30">
        <OrreryMark class="size-5 text-white" />
      </div>
      <div class="flex flex-col">
        <h2 class="text-lg font-semibold tracking-tight">Getting started</h2>
        <p class="text-[13px] text-muted">{{ steps.length }} steps to a session working from your roadmap. Each ticks itself.</p>
      </div>
    </div>
    <div class="h-1 overflow-hidden rounded-full bg-well" role="progressbar" :aria-valuenow="done" :aria-valuemax="steps.length" aria-label="Steps done">
      <div class="h-full rounded-full bg-accent-fill transition-all" :style="{width: `${(done / steps.length) * 100}%`}" />
    </div>
    <div class="flex flex-col gap-2 text-[13px] text-muted" data-step="agent">
      <span class="font-medium text-fg">Which AI agent do you run?</span>
      <AgentPicker />
    </div>
    <OtherAgent v-if="otherAgent" />
    <div v-else-if="!machineReady" class="flex flex-col gap-2 rounded-xl bg-panel p-4 text-[13px] leading-relaxed text-muted ring-1 ring-line" data-step="machine">
      <span class="font-medium text-fg">Set up this machine once</span>
      <span>
        Run this in a terminal, from any folder. It installs the launcher, so orrery can start sessions, and adds orrery to
        Claude Code for every folder, so a <span class="font-mono">claude</span> anywhere reaches it, repo or not. Safe to run again;
        <span class="font-mono">--uninstall</span> in place of <span class="font-mono">--install</span> takes it all out. Needs tmux 3.2 or newer.
      </span>
      <CopyBlock title="Anywhere on your machine, run" :text="machineLine" />
    </div>
    <ol class="flex flex-col gap-4 text-[13px] leading-relaxed text-muted">
      <template v-for="(step, i) in steps" :key="step.key">
      <li v-if="i === WITHOUT_CLAUDE" class="px-4 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint">For working with agents</li>
      <li class="flex gap-3 rounded-xl" :class="i === current && !step.done && !(planning && i >= WITHOUT_CLAUDE) ? 'bg-panel p-4 ring-1 ring-line' : ['px-4', planning && i >= WITHOUT_CLAUDE && !step.done && 'opacity-60']">
        <StepMark :done="step.done" :n="i + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span class="font-medium" :class="step.done ? 'text-muted' : 'text-fg'">{{ TEXT[i]!.title }}</span>
          <template v-if="i === current && !step.done && !(planning && i >= WITHOUT_CLAUDE)">
            <span>{{ textOf(i, step.key) }}</span>
            <div v-if="step.key === 'project'" class="flex flex-wrap items-center gap-2">
              <UiButton variant="primary" size="md" @click="newProject = true">New project</UiButton>
              <UiButton size="md" :disabled="demo.making.value" title="A sample board to look around first; delete it from its Settings" @click="tryDemo">
                <UiBusy :busy="demo.making.value" label="Making the demo…">Try it with a demo project</UiBusy>
              </UiButton>
              <span v-if="demo.failed.value" class="text-xs text-rose-700 dark:text-rose-400">{{ demo.failed.value }}</span>
            </div>
            <CopyBlock v-else-if="step.key === 'connect'" title="Paste into a session, in the folder" :text="pieces.prompt" />
            <CopyBlock v-else-if="step.key === 'listen' && !otherAgent" title="In the folder, start a session with" :text="pieces.launch" />
            <UiButton v-else-if="step.key === 'work' && project" variant="primary" size="md" class="self-start" @click="newIssue(project.id)">New issue</UiButton>
            <LauncherHint v-if="step.key === 'work' && project" :project="project.id" />
          </template>
        </div>
      </li>
      </template>
      <li v-if="current >= WITHOUT_CLAUDE && !finished" class="px-4">
        <button type="button" class="text-xs text-accent-700 hover:underline dark:text-accent-400" @click="plan()">Just planning? You're set</button>
      </li>
      <li v-else-if="planning && done < steps.length" class="px-4 text-xs text-faint">
        You're set for planning.
        <button type="button" class="text-accent-700 hover:underline dark:text-accent-400" @click="plan(false)">Working with agents after all?</button>
      </li>
      <li class="flex gap-3 px-4" data-step="phone">
        <StepMark :done="phone.done" :n="steps.length + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span class="font-medium" :class="phone.done ? 'text-muted' : 'text-fg'">{{ PHONE.title }} <span class="font-normal text-faint">· optional</span></span>
          <template v-if="!phone.done">
            <span>{{ PHONE.text }}</span>
            <PhoneLink v-if="showPhone" />
            <UiButton v-else size="md" class="self-start" @click="showPhone = true">Show the code</UiButton>
          </template>
        </div>
      </li>
    </ol>
    <p class="text-xs text-faint">
      Later: let orrery start sessions itself, from the <NuxtLink to="/sessions#starts" class="text-accent-700 underline underline-offset-2 dark:text-accent-400">Sessions page</NuxtLink>.
      Every step by hand is on <NuxtLink to="/connect" class="text-accent-700 underline underline-offset-2 dark:text-accent-400">Connect an agent</NuxtLink>.
    </p>
  </div>
</template>
