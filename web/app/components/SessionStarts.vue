<script setup lang="ts">
// Whether orrery may start Claude sessions itself, with no terminal: the owner's one opt-in, for every project whose
// repo has a launcher installed (how many at once, over every project, how many to keep running, and, if they like, how long
// each runs and how long one may sit idle; blank runs it until stopped), and whether work finding nobody listening starts
// one, with a line on what starts sessions. On the Sessions page, above the sessions.
const {settings, save: saveSettings} = useAppSettings()
const {byProject} = useSchedules()
const failed = ref('')
const field = 'h-8 w-20 field'

const limit = ref(1)
// Blank (an empty input gives '') is no minimum, and no limit on the minutes.
const min = ref<number | ''>('')
const minutes = ref<number | ''>('')
const idleMinutes = ref<number | ''>('')
const onSignal = ref(true)
// Only when they change: a live update that brings the same values back would undo what's being typed.
watch(() => JSON.stringify(settings.value.starts ?? null), () => {
    const starts = settings.value.starts
    limit.value = starts?.limit ?? 1
    min.value = starts?.min ?? ''
    minutes.value = starts?.minutes ?? ''
    idleMinutes.value = starts?.idle_minutes ?? ''
    onSignal.value = starts?.on_signal !== false
}, {immediate: true})

// The schedules that start sessions, while running: a session schedule, an untrusted one (its run gets a session of its
// own), and, while work finding nobody listening starts one, a message schedule or an issue schedule that asks a session.
const starting = computed(() => Object.values(byProject.value).flat().filter(s => s.enabled
    && (s.kind === 'session' || s.untrusted || onSignal.value && (s.kind === 'message' || s.kind === 'issue' && s.ask))).length)

async function saveStarts(on = !!settings.value.starts) {
    failed.value = ''
    // A limit lowered below the minimum takes the minimum down with it, which may never be more (ORR-479).
    if (min.value && min.value > limit.value) min.value = limit.value
    try {
        await saveSettings({starts: on ? {limit: limit.value, ...min.value ? {min: min.value} : {}, ...minutes.value ? {minutes: minutes.value} : {}, ...idleMinutes.value ? {idle_minutes: idleMinutes.value} : {}, ...onSignal.value ? {} : {on_signal: false}} : null})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]">
    <label class="flex items-center gap-2 text-fg">
      <input type="checkbox" class="accent-accent-500" :checked="!!settings.starts" @change="saveStarts(($event.target as HTMLInputElement).checked)">
      Let orrery start sessions
    </label>
    <label class="flex items-center gap-2 text-xs text-muted" :class="{'opacity-50': !settings.starts}">
      <input v-model="onSignal" type="checkbox" class="accent-accent-500" :disabled="!settings.starts" @change="saveStarts()">
      Start a session when work arrives and nobody's listening
    </label>
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted" :class="{'opacity-50': !settings.starts}">
      <span>At most</span>
      <input v-model.number="limit" type="number" min="1" max="20" aria-label="Sessions at once" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>at once, over every project. Keep at least</span>
      <input v-model.number="min" type="number" min="1" :max="limit" placeholder="none" aria-label="Sessions kept running" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>running. Stop each after</span>
      <input v-model.number="minutes" type="number" min="1" max="1440" placeholder="never" aria-label="Minutes each" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>minutes, or once idle for</span>
      <input v-model.number="idleMinutes" type="number" min="1" max="1440" placeholder="never" aria-label="Idle minutes" :class="field" :disabled="!settings.starts" @change="saveStarts()">
      <span>minutes.</span>
    </div>
    <p class="text-xs text-muted" :class="{'opacity-50': !settings.starts}">
      orrery starts a session {{ onSignal ? "when work reaches a project nobody's listening on" : 'when you press Start session or Focus on this' }}, or when
      one of your schedules starts one
      (<NuxtLink to="/schedules" class="text-accent-600 hover:underline dark:text-accent-400">{{ starting === 1 ? '1 does' : `${starting} do` }}</NuxtLink>).
    </p>
    <p class="text-xs text-faint" :class="{'opacity-50': !settings.starts}">
      Left blank, a session runs until you stop it. Neither stops one mid-work: it waits until the session is idle with nothing in progress.
      With a minimum, one stopped that way is replaced by a fresh one with the same presets; one you stop yourself isn't.
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
