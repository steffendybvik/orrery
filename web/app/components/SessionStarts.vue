<script setup lang="ts">
// Whether Orrery may start Claude sessions itself, with no terminal: the owner's one opt-in, for every project whose
// repo has a launcher installed (how many at once on each, and, if they like, how long each runs and how long one
// may sit idle; blank runs it until stopped). On the Sessions page, above the sessions.
const {settings, save: saveSettings} = useAppSettings()
const failed = ref('')
const field = 'h-8 w-20 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'

const limit = ref(1)
// Blank (an empty input gives '') is no limit.
const minutes = ref<number | ''>('')
const idleMinutes = ref<number | ''>('')
watch(() => settings.value.starts, starts => {
    limit.value = starts?.limit ?? 1
    minutes.value = starts?.minutes ?? ''
    idleMinutes.value = starts?.idle_minutes ?? ''
}, {immediate: true})

async function saveStarts(on = !!settings.value.starts) {
    failed.value = ''
    try {
        await saveSettings({starts: on ? {limit: limit.value, ...minutes.value ? {minutes: minutes.value} : {}, ...idleMinutes.value ? {idle_minutes: idleMinutes.value} : {}} : null})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]">
    <label class="flex items-center gap-2 text-fg">
      <input type="checkbox" class="accent-accent-500" :checked="!!settings.starts" @change="saveStarts(($event.target as HTMLInputElement).checked)">
      Let Orrery start sessions
    </label>
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted" :class="{'opacity-50': !settings.starts}">
      <span>At most</span>
      <input v-model.number="limit" type="number" min="1" max="20" aria-label="Sessions at once" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>at once on each project. Stop each after</span>
      <input v-model.number="minutes" type="number" min="1" max="1440" placeholder="never" aria-label="Minutes each" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>minutes, or once idle for</span>
      <input v-model.number="idleMinutes" type="number" min="1" max="1440" placeholder="never" aria-label="Idle minutes" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>minutes.</span>
    </div>
    <p class="text-xs text-faint" :class="{'opacity-50': !settings.starts}">
      Left blank, a session runs until you stop it. Neither stops one mid-work: it waits until the session is idle with nothing in progress.
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
