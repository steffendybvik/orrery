<script setup lang="ts">
// Getting started: the steps from a new Orrery to a Claude session working from it, each ticked from what the
// Orrery knows (useGettingStarted), with what to do for the one you're on. As a page it's the first run (in place
// of "No projects yet", and at /getting-started); `card` is its fold-away form at the top of Now.
defineProps<{card?: boolean}>()

const {steps, done, current, finished, project, hide} = useGettingStarted()
const pieces = useConnect(project)
const newProject = useState('new-project', () => false)
const {open: newIssue} = useNewIssue()
const demo = useDemoProject()
const router = useRouter()
const open = ref(true)

const TEXT = [
    {title: 'You own this Orrery', text: 'What you make, no one else can delete. Your name is in App settings.'},
    {title: 'Make a project', text: 'One for each app or repo. Its issues get a key of their own, like SHP-1.'},
    {title: 'Connect its repo', text: "Paste this into a Claude session in the app's repo. It writes the repo's .mcp.json, hooks and CLAUDE.md itself, and the step ticks once the session says hello."},
    {title: 'Start Claude with the channel', text: 'So Orrery can send the session work. Ticked once a session is listening.'},
    {title: 'Send it work', text: 'Make an issue and press Focus on this on its page, or ask from the Sessions page. Ticked when a session starts one.'},
]

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
      <li v-for="(step, i) in steps" :key="step.key" class="flex gap-3" :class="!step.done && i !== current && 'opacity-60'">
        <StepMark :done="step.done" :n="i + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="font-medium" :class="step.done ? 'text-muted line-through decoration-faint' : 'text-fg'">{{ TEXT[i]!.title }}</span>
          <template v-if="i === current && !step.done">
            <span>{{ TEXT[i]!.text }}</span>
            <UiButton v-if="step.key === 'project'" variant="primary" class="self-start" @click="newProject = true">New project</UiButton>
            <CopyBlock v-else-if="step.key === 'connect'" title="Paste into Claude, in the repo" :text="pieces.prompt" />
            <CopyBlock v-else-if="step.key === 'listen'" title="In the repo, start Claude with" :text="pieces.launch" :hint="`An alias saves typing it: alias ${project?.id ?? 'app'}='cd /path/to/repo && ${pieces.launch}'`" />
            <UiButton v-else-if="step.key === 'work' && project" variant="primary" class="self-start" @click="newIssue(project.id)">New issue</UiButton>
          </template>
        </div>
      </li>
    </ol>
  </section>

  <div v-else class="mx-auto flex w-full max-w-xl animate-fade-up flex-col gap-6 px-4 py-14">
    <div class="flex items-center gap-3">
      <div class="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-accent-300 to-accent-600 shadow-lg shadow-accent-600/30">
        <OrreryMark class="size-5 text-zinc-950" />
      </div>
      <div class="flex flex-col">
        <h1 class="text-lg font-semibold tracking-tight">Getting started</h1>
        <p class="text-[13px] text-muted">{{ steps.length }} steps to a Claude session working from your roadmap. Each ticks itself.</p>
      </div>
    </div>
    <div class="h-1 overflow-hidden rounded-full bg-well" role="progressbar" :aria-valuenow="done" :aria-valuemax="steps.length" aria-label="Steps done">
      <div class="h-full rounded-full bg-accent-500 transition-all" :style="{width: `${(done / steps.length) * 100}%`}" />
    </div>
    <ol class="flex flex-col gap-4 text-[13px] leading-relaxed text-muted">
      <li v-for="(step, i) in steps" :key="step.key" class="flex gap-3 rounded-xl" :class="i === current && !step.done ? 'bg-panel p-4 ring-1 ring-line' : 'px-4'">
        <StepMark :done="step.done" :n="i + 1" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <span class="font-medium" :class="step.done ? 'text-muted' : 'text-fg'">{{ TEXT[i]!.title }}</span>
          <template v-if="i === current && !step.done">
            <span>{{ TEXT[i]!.text }}</span>
            <div v-if="step.key === 'project'" class="flex flex-wrap items-center gap-2">
              <UiButton variant="primary" size="md" @click="newProject = true">New project</UiButton>
              <UiButton size="md" :disabled="demo.making.value" title="A sample board to look around first; delete it from its Settings" @click="tryDemo">
                {{ demo.making.value ? 'Making the demo…' : 'Try it with a demo project' }}
              </UiButton>
              <span v-if="demo.failed.value" class="text-xs text-rose-600 dark:text-rose-400">{{ demo.failed.value }}</span>
            </div>
            <CopyBlock v-else-if="step.key === 'connect'" title="Paste into Claude, in the repo" :text="pieces.prompt" />
            <CopyBlock v-else-if="step.key === 'listen'" title="In the repo, start Claude with" :text="pieces.launch" />
            <UiButton v-else-if="step.key === 'work' && project" variant="primary" size="md" class="self-start" @click="newIssue(project.id)">New issue</UiButton>
          </template>
        </div>
      </li>
    </ol>
    <p class="text-xs text-faint">
      Later: let Orrery start sessions itself, from the <NuxtLink to="/sessions#starts" class="text-accent-600 hover:underline dark:text-accent-400">Sessions page</NuxtLink>.
      Every step by hand is on <NuxtLink to="/connect" class="text-accent-600 hover:underline dark:text-accent-400">Connect an agent</NuxtLink>.
    </p>
  </div>
</template>
