<script setup lang="ts">
// Sessions → Setup: what a session does when it runs out of work (ORR-452). Off, it waits to be pointed at an issue;
// on, every listening session out of work is handed the issues it may start (Todo, then Backlog, most urgent first)
// and picks one itself, and is handed them again when the board changes.
const {settings, save} = useAppSettings()
const failed = ref('')
async function set(on: boolean) {
    failed.value = ''
    try {
        await save({pick_next: on})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label class="flex items-center gap-2 text-xs text-muted">
      <input type="checkbox" class="accent-accent-500" :checked="settings.pick_next" @change="set(($event.target as HTMLInputElement).checked)">
      When a session runs out of work, it picks its next issue
    </label>
    <p class="text-xs text-faint">
      Every listening session, whoever started it, is handed the issues it may start: Todo, or Backlog once Todo is empty,
      most urgent first, without proposals or anything waiting on you. It starts the one it judges best, and may pass over
      one it can't do yet, saying why. With nothing to pick, it stays idle until the board changes. Off, it waits for you.
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
