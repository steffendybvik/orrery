<script setup lang="ts">
// What to install so orrery can start a project's sessions itself, shown only while no launcher is running for it, and
// gone as one connects (useLaunchState hears the launchers come and go). The page only sees whether one is connected,
// not whether it's installed, so it says what's missing either way and where the launcher's log is (ORR-426). In the
// chat (`chat`) it says the chat needs it, as its message can't go without one (ORR-591). A project with no repo needs
// none: the launcher serves it from its machine's default folder (ORR-1063), so it's never asked for one.
const props = defineProps<{project: string, chat?: boolean}>()

const {byId} = useRoadmaps()
const {settings} = useAppSettings()
const {state, install} = useLaunchState(() => props.project)
const name = computed(() => byId(props.project)?.name ?? props.project)
const noRepo = computed(() => !byId(props.project)?.repo)
const home = computed(() => `~/.orrery/${settings.value.id || '<orrery id>'}/home`)
</script>

<template>
  <div v-if="state && !state.launchers" class="flex flex-col gap-2 rounded-xl bg-well p-3 text-xs leading-relaxed text-muted ring-1 ring-line">
    <p>
      <span class="font-medium text-fg">No launcher is running for {{ name }}.</span>{{ ' ' }}
      <template v-if="noRepo">
        {{ chat ? 'The chat starts its session through it.' : 'orrery starts its sessions through it.' }}
        It needs no repo: install the launcher once, from any folder, and run <span class="font-mono">claude</span>
        once in <span class="font-mono">{{ home }}</span> to trust it. Installed already? Then no machine running it is on.
      </template>
      <template v-else-if="chat">The chat starts its session through it: install the launcher once, then open a Claude session in the repo, or run this there to add it now.</template>
      <template v-else>
        For orrery to start its sessions itself (Start session, or work sent while nobody is listening), install the launcher
        once, then open a Claude session in the repo, or run this there to add it now.
      </template> It needs tmux 3.2 or newer<template v-if="!noRepo">, and <span class="font-mono">claude</span> run there once first, to trust
        the folder</template>. Installed and still not running? Its log says why: <span class="font-mono">~/Library/Logs/orrery-launcher.log</span>
      on macOS, <span class="font-mono">journalctl --user -u orrery-launcher</span> on Linux.
    </p>
    <CopyBlock :title="noRepo ? 'Anywhere on your machine, run' : 'In the repo, run'" :text="install" />
  </div>
</template>
