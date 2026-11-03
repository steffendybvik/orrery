<script setup lang="ts">
// Run schedule, in a project's issues toolbar (ORR-687): a menu of the schedules Run now can run, as ScheduleMenu has it
// (one that moves issues needs its event), each run at once on top of its timetable. It stays open with the error when
// a run fails. No such schedule, no button.
import {Popover, PopoverButton, PopoverPanel} from '@headlessui/vue'
import type {Schedule} from '#shared/roadmap'

const props = defineProps<{project: string}>()
const {of, run} = useSchedules()

const runnable = computed(() => of(props.project).filter(s => s.kind !== 'action'))
const busy = ref(false)
const failed = ref('')

const nextOf = (s: Schedule) => !s.enabled ? s.at ? 'Has run' : 'Paused' : s.next_run ? `Next ${when(s.next_run)}` : 'When something happens'

async function pick(s: Schedule, close: () => void) {
    busy.value = true
    failed.value = await run(s) ?? ''
    busy.value = false
    if (!failed.value) close()
}
</script>

<template>
  <Popover v-if="runnable.length" v-slot="{close}" class="relative shrink-0">
    <PopoverButton as="template">
      <UiButton title="Run a schedule now" aria-label="Run schedule" @click="failed = ''">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" /></svg>
        <span class="max-sm:hidden">Run schedule</span>
      </UiButton>
    </PopoverButton>
    <PopoverPanel class="menu absolute top-full right-0 z-40 mt-1.5 max-h-80 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <UiMenuItem v-for="s in runnable" :key="s.id" :disabled="busy" @click="pick(s, close)">
        <span class="flex min-w-0 flex-col">
          <span class="truncate">{{ s.title }}</span>
          <span class="truncate text-xs text-faint">{{ nextOf(s) }}</span>
        </span>
      </UiMenuItem>
      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    </PopoverPanel>
  </Popover>
</template>
