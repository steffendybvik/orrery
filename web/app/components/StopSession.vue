<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'

// The owner's Stop for a session opened in a terminal, under its card's ⋯ as a started session's is (ORR-1220), and
// not red: its orrery channel ends it, on the first press (ORR-971).
const props = defineProps<{session: Session}>()
const busy = ref(false)
const failed = ref('')

async function stop() {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/sessions/${encodeURIComponent(props.session.id)}/stop`, {
            method: 'POST',
        })
    } catch (error) {
        failed.value = errorMessage(error, 'stop')
        busy.value = false
    }
}
</script>

<template>
  <span class="flex shrink-0 items-center gap-1.5 text-xs">
    <span v-if="failed" class="text-rose-700 dark:text-rose-400">{{ failed }}</span>
    <span v-if="busy" class="text-faint">Stopping…</span>
    <Menu as="div" class="relative">
      <MenuButton as="template">
        <UiButton size="xs" square :aria-label="`More for ${session.name}`" :title="`More for ${session.name}`">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
        </UiButton>
      </MenuButton>
      <MenuItems class="menu absolute top-full right-0 z-40 mt-1.5 w-60 max-w-[calc(100vw-2rem)]">
        <MenuItem v-slot="{active}" as="template">
          <UiMenuItem :lit="active" :disabled="busy" :title="`End ${session.name}: it quits in its terminal`" @click="stop">Stop</UiMenuItem>
        </MenuItem>
      </MenuItems>
    </Menu>
  </span>
</template>
