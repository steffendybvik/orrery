<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {TERMINALS} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'

// A session orrery started, at the end of its card's first row: Watch (its launcher opens a terminal on it), Show
// screen (`viewing`, its live screen on the page) and Stop out front, Stop asking once more, as whatever the session
// was in the middle of goes with it; the rest under ⋯: the command that attaches to its tmux session to copy, and the
// owner's +30 min (for one with a time). Headless UI's Menu does the keys, focus and outside-click.
const props = defineProps<{session: Session}>()
const viewing = defineModel<boolean>('viewing', {default: false})
const busy = ref<'stop' | 'extend' | 'watch' | null>(null)
const {settings} = useAppSettings()
const failed = ref('')
const stopping = ref(false)
const note = ref('')

async function act(what: 'stop' | 'extend' | 'watch') {
    const launch = props.session.started?.launch
    if (!launch) return
    busy.value = what
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/launches/${launch}/${what}`, {
            method: 'POST', body: what === 'extend' ? {minutes: 30} : {},
        })
        stopping.value = false
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = null
    }
}

async function copyAttach() {
    if (props.session.started && await copyText(`tmux attach -t ${props.session.started.tmux}`)) {
        note.value = 'Copied'
        setTimeout(() => note.value = '', 2000)
    }
}
</script>

<template>
  <span v-if="session.started" class="flex shrink-0 items-center gap-1.5 text-xs">
    <span v-if="failed" class="text-rose-700 dark:text-rose-400">{{ failed }}</span>
    <span v-if="note" class="text-faint">{{ note }}</span>
    <template v-if="stopping">
      <span class="text-muted">Stop {{ session.name }}?</span>
      <UiButton variant="danger-outline" size="xs" :disabled="!!busy" @click="act('stop')">{{ busy === 'stop' ? 'Stopping…' : 'Stop' }}</UiButton>
      <UiButton size="xs" :disabled="!!busy" @click="stopping = false">Cancel</UiButton>
    </template>
    <template v-else>
      <UiButton
          size="xs"
          :disabled="!!busy"
          :title="`Open ${TERMINALS[settings.terminal]} on ${session.name}, on its launcher's machine`"
          @click="act('watch')"
      >
        {{ busy === 'watch' ? 'Opening…' : 'Watch' }}
      </UiButton>
      <UiButton size="xs" :aria-expanded="viewing" @click="viewing = !viewing">{{ viewing ? 'Hide screen' : 'Show screen' }}</UiButton>
      <UiButton variant="danger-outline" size="xs" :disabled="!!busy" :title="`Stop ${session.name}`" @click="stopping = true">Stop</UiButton>
      <Menu as="div" class="relative">
        <MenuButton as="template">
          <UiButton size="xs" square :aria-label="`More for ${session.name}`" :title="`More for ${session.name}`">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </UiButton>
        </MenuButton>
        <MenuItems class="menu absolute top-full right-0 z-40 mt-1.5 w-60">
          <MenuItem v-if="session.started.stops_at" v-slot="{active}" as="template">
            <UiMenuItem :lit="active" :disabled="!!busy" @click="act('extend')">+30 minutes</UiMenuItem>
          </MenuItem>
          <MenuItem v-slot="{active}" as="template">
            <UiMenuItem :lit="active" @click="copyAttach">
              <span class="min-w-0 flex-1 truncate">Copy <code class="font-mono text-[11px]">tmux attach -t {{ session.started.tmux }}</code></span>
            </UiMenuItem>
          </MenuItem>
        </MenuItems>
      </Menu>
    </template>
  </span>
</template>
