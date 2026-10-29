<script setup lang="ts">
// How orrery starts sessions with no terminal, step by step, each ticked once it's done: the owner's opt-in, a
// launcher installed in a project's repo, then starting, watching and stopping them. Open while a step is left.
import type {LaunchState} from '~/composables/useLaunchState'

const {settings} = useAppSettings()
const {launchers} = useRoadmaps()
const {ordered} = useProjectOrder()
/** Whether any project has a launcher running, asked of each, and again as launchers come and go; null until known. */
const running = ref<boolean | null>(null)
async function ask() {
    const states = await Promise.all(ordered.value.map(p => $fetch<LaunchState>(`/api/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)))
    running.value = states.some(s => !!s?.launchers)
}
watch([() => ordered.value.length, launchers], ask, {immediate: true})
const ready = computed(() => !!settings.value.starts && !!running.value)
</script>

<template>
  <details class="group rounded-xl border border-line dark:bg-panel" :open="running !== null && !ready">
    <summary class="flex list-none items-center gap-2 px-4 py-3 text-[13px] font-medium text-fg">
      <svg class="size-3 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      How orrery starts sessions, with no terminal
      <span v-if="ready" class="ml-auto text-xs font-normal text-emerald-600 dark:text-emerald-400">set up</span>
    </summary>
    <ol class="flex flex-col gap-4 px-4 pb-4 text-[13px] leading-relaxed text-muted">
      <li class="flex gap-3">
        <StepMark :done="!!settings.starts" :n="1" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Let orrery start sessions</span>
          <span>
            Once, for every project, above:
            how many may run at once, over every project, and, if you like, how many to keep running and how long each runs or may sit idle.
          </span>
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="!!running" :n="2" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-col gap-0.5">
            <span class="font-medium text-fg">Install the launcher, once in each project's repo</span>
            <span>
              orrery runs in Docker and can't start sessions on your machine, so a small launcher does it. Installed, it runs in the
              background (launchd on macOS, systemd on Linux), starts at login and serves every project installed this way.
              It finds the project in the repo's <span class="font-mono">.mcp.json</span>. If it's new to the repo,
              run <span class="font-mono">claude</span> there once to trust the folder. Its command is at the top of this section.
            </span>
          </div>
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="false" :n="3" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Start one</span>
          <span>
            Press <strong class="font-medium text-fg">Start session</strong> above, or send a project work (focus on an issue, a chunk,
            a comment) while no session is listening on it. It runs <span class="font-mono">claude</span> in a detached tmux session in the repo, with the channel, in
            <span class="font-mono">auto</span> permission mode, as nobody is there to answer a prompt.
          </span>
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="false" :n="4" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Watch it, give it longer, or stop it</span>
          <span>
            It lists here like any session. <strong class="font-medium text-fg">Watch</strong> opens a terminal on it (the app picked in
            <NuxtLink to="/sessions#watch" class="text-accent-600 hover:underline dark:text-accent-400">Watching sessions</NuxtLink>),
            <strong class="font-medium text-fg">Stop</strong> ends it now, and <strong class="font-medium text-fg">+30 min</strong> gives one with minutes longer.
            One whose minutes are up, or that has sat idle too long, is stopped once it's done with what it's on. The launcher's log is <span class="font-mono">~/Library/Logs/orrery-launcher.log</span>
            on macOS, <span class="font-mono">journalctl --user -u orrery-launcher</span> on Linux.
          </span>
        </div>
      </li>
    </ol>
  </details>
</template>
