<script setup lang="ts">
import type {Project} from '#shared/roadmap'
import {startsFor} from '#shared/roadmap'

// How Orrery starts sessions for a project with no terminal, step by step, each ticked once it's done: the
// owner's opt-in (once, for every project), the launcher installed on the host, then starting, watching and stopping them. Open while a step
// is left.
const props = defineProps<{project: Project}>()
const {state, install} = useLaunchState(() => props.project.id)
const running = computed(() => state.value?.launchers ?? null)
const {settings} = useAppSettings()
const allowed = computed(() => !!startsFor(props.project, settings.value))
const ready = computed(() => allowed.value && !!running.value)
</script>

<template>
  <details class="group rounded-xl border border-line" :open="running !== null && !ready">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-medium text-fg">
      <svg class="size-3 text-faint transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      How Orrery starts sessions, with no terminal
      <span v-if="ready" class="ml-auto text-xs font-normal text-emerald-600 dark:text-emerald-400">set up</span>
    </summary>
    <ol class="flex flex-col gap-4 px-4 pb-4 text-[13px] leading-relaxed text-muted">
      <li class="flex gap-3">
        <StepMark :done="allowed" :n="1" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Let Orrery start sessions</span>
          <span>
            Once, for every project, in <NuxtLink to="/settings#starts" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">App settings</NuxtLink>,
            then say how many may run at once ({{ project.name }} can have its own above). Each runs until you stop it, unless you give it minutes,
            or minutes it may sit idle with nothing to do.
          </span>
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="!!running" :n="2" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-col gap-0.5">
            <span class="font-medium text-fg">Install the launcher, once, in {{ project.name }}'s repo</span>
            <span>
              Orrery runs in Docker and can't start Claude on your machine, so a small launcher does it. Installed, it runs in the
              background (launchd on macOS, systemd on Linux), starts at login and serves every project installed this way.
              It finds the project in the repo's <span class="font-mono">.mcp.json</span>. If Claude hasn't run in the repo before,
              run <span class="font-mono">claude</span> there once to trust the folder.
            </span>
          </div>
          <CopyBlock title="In the repo, run" :text="install" hint="Again in another repo adds its project; --uninstall takes one off. Installing again restarts it, which stops the sessions it's running." />
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="false" :n="3" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Start one</span>
          <span>
            Press <strong class="font-medium text-fg">Start session</strong> above, or send {{ project.name }} work (focus on an issue, a chunk,
            a comment) while no session is listening. It runs Claude in a detached tmux session in the repo, with the channel, in
            <span class="font-mono">auto</span> permission mode, as nobody is there to answer a prompt.
          </span>
        </div>
      </li>
      <li class="flex gap-3">
        <StepMark :done="false" :n="4" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="font-medium text-fg">Watch it, give it longer, or stop it</span>
          <span>
            It lists here like any session. <strong class="font-medium text-fg">Watch</strong> copies the command that opens it in a terminal,
            <strong class="font-medium text-fg">Stop</strong> ends it now, and <strong class="font-medium text-fg">+30 min</strong> gives one with minutes longer.
            One whose minutes are up, or that has sat idle too long, is stopped once it's done with what it's on. The launcher's log is <span class="font-mono">~/Library/Logs/orrery-launcher.log</span>
            on macOS, <span class="font-mono">journalctl --user -u orrery-launcher</span> on Linux.
          </span>
        </div>
      </li>
    </ol>
  </details>
</template>
