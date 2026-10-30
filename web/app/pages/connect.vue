<script setup lang="ts">
// Connect an agent: a button that has the launcher set a repo up (ConnectRepo), or one line to give a Claude session in
// an app's repo. It points the agent at the
// brief (/connect/<project>.md), which says how to keep the roadmap here and has it set the repo up
// itself. The pieces are also here, folded, to set up by hand.
useHead({title: 'Connect an agent · orrery'})
const route = useRoute()
const router = useRouter()
const {ordered} = useProjectOrder()
const origin = import.meta.client ? location.origin : 'http://localhost:9000'
const picked = computed({
    get: () => (route.query.project as string | undefined) ?? ordered.value[0]?.id ?? 'new',
    set: id => router.replace({query: {project: id}}),
})
const newName = ref('')
const sessionName = ref('')
const project = computed(() => ordered.value.find(p => p.id === picked.value))
const pieces = useConnect(project, {name: newName, session: sessionName})
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></svg>
    <h1 class="truncate text-sm font-medium">Connect an agent</h1>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-3xl animate-fade-up flex-col gap-8 px-4 py-8 sm:px-8 sm:py-12">
      <header class="flex flex-col gap-3">
        <h2 class="text-2xl font-semibold tracking-tight">Give a session its roadmap</h2>
        <p class="text-[15px] leading-relaxed text-muted">
          Connect a repo with a click, or pick the app and copy the line into a session in its repo. The agent reads its brief
          from orrery, starts keeping the roadmap here and sets the repo up, then asks you to restart it so orrery can reach the window.
          Any agent can also start from <a :href="`${origin}/llms.txt`" target="_blank" class="text-accent-700 underline underline-offset-2 dark:text-accent-400">/llms.txt</a>.
        </p>
      </header>

      <ConnectRepo />

      <div class="flex flex-col gap-1">
        <h3 class="text-[15px] font-semibold">Or give an agent the line</h3>
        <p class="text-[13px] leading-relaxed text-muted">For a repo on a machine with no folder picker, or if you'd rather an agent did it.</p>
      </div>

      <section class="flex flex-col gap-3">
        <h3 class="label">The app</h3>
        <div class="flex flex-wrap gap-1.5">
          <button
              v-for="p in ordered"
              :key="p.id"
              type="button"
              class="flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] ring-1 transition-colors"
              :class="picked === p.id ? 'bg-active text-fg ring-faint/50' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
              @click="picked = p.id"
          >
            {{ p.name }} <span class="font-mono text-[10px] text-faint">{{ p.key }}</span>
          </button>
          <button
              type="button"
              class="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] ring-1 transition-colors"
              :class="!project ? 'bg-active text-fg ring-faint/50' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
              @click="picked = 'new'"
          >+ A new app</button>
        </div>
        <div class="flex flex-wrap gap-4">
          <label v-if="!project" class="flex min-w-56 flex-1 flex-col gap-1.5">
            <span class="text-xs text-faint">Its name (the agent creates the project)</span>
            <input v-model="newName" placeholder="e.g. fitness-app" class="h-8 rounded-lg bg-well px-3 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
          </label>
          <label class="flex min-w-56 flex-1 flex-col gap-1.5">
            <span class="text-xs text-faint">Name the window (optional): shows in orrery, e.g. what it works on</span>
            <input v-model="sessionName" placeholder="e.g. joints" class="h-8 rounded-lg bg-well px-3 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
          </label>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-2xl bg-accent-500/5 p-5 ring-1 ring-accent-500/25">
        <div class="flex items-center gap-3">
          <h3 class="flex-1 text-[15px] font-semibold">Paste this into a session in the repo</h3>
          <CopyButton :text="pieces.prompt" />
        </div>
        <p class="rounded-lg bg-canvas/60 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed wrap-break-word text-fg ring-1 ring-line">{{ pieces.prompt }}</p>
      </section>

      <details class="group rounded-2xl bg-well/50 ring-1 ring-line">
        <summary class="flex list-none items-center gap-2 px-5 py-4 text-[13px] font-medium text-fg">
          <svg class="size-3 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          What the agent reads
          <a :href="pieces.url" target="_blank" class="ml-auto font-mono text-[11px] font-normal text-faint hover:text-fg" @click.stop>{{ pieces.url.replace(origin, '') }}</a>
        </summary>
        <div class="px-5 pb-5"><MarkdownView :source="pieces.brief" class="text-[14px]" /></div>
      </details>

      <details class="group rounded-2xl bg-well/50 ring-1 ring-line">
        <summary class="flex list-none items-center gap-2 px-5 py-4 text-[13px] font-medium text-fg">
          <svg class="size-3 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          Set it up by hand
        </summary>
        <div class="flex flex-col gap-6 px-5 pb-5">
          <CopyBlock title="CLAUDE.md section" :text="pieces.claudeMd" />
          <CopyBlock title="Once on this machine" hint="Runs the channel and hooks as this orrery serves them, so they upgrade with it. Needs Node." :text="pieces.bootstrap" />
          <CopyBlock title=".mcp.json" :text="pieces.mcpJson" />
          <CopyBlock title=".claude/settings.json" hint="Merge into the file if it exists." :text="pieces.settingsJson" />
          <CopyBlock title="Start the session with" :hint="`It asks once to approve the ${pieces.server} server; say yes.`" :text="pieces.launch" />
          <CopyBlock title="Without the preview: ask the session to watch" hint="Uses the Monitor tool; a watch lasts up to 30 minutes, then the session restarts it." :text="pieces.monitor" />
        </div>
      </details>
    </div>
  </div>
</template>
