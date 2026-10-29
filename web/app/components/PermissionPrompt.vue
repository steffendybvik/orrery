<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// A session at a permission prompt pops up on whatever page the owner has open (ORR-489): what it wants, as its pane
// shows it (orrery started it) or as Claude Code's notification says it, with Allow (its launcher answers "Yes" once,
// only while the prompt is still there) and Open tmux (Watch). One started by hand has no tmux orrery knows, so it
// says what it wants without the buttons. It goes once the session moves on; × hides it until it asks again.
const props = defineProps<{session: Session}>()
const emit = defineEmits<{close: []}>()
const {load} = useOwner()
const screen = ref<string | null>(null)
const busy = ref<'allow' | 'watch' | null>(null)
const failed = ref('')
const launch = computed(() => props.session.started?.launch)
const prompt = computed(() => screen.value ? promptIn(screen.value) : null)

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
async function poll() {
    if (stopped || !launch.value) return
    if (document.visibilityState === 'visible') {
        try {
            const shot = await $fetch<{screen: string | null}>(
                `/api/projects/${encodeURIComponent(props.session.project)}/launches/${launch.value}/screen`,
                {headers: {'Orrery-Actor': await load()}},
            )
            screen.value = shot.screen
        } catch {
            // No launcher to send it: the notification's words stand in.
        }
    }
    if (!stopped) timer = setTimeout(poll, 1000)
}
onMounted(poll)
onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
})

async function act(what: 'allow' | 'watch') {
    busy.value = what
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.session.project)}/launches/${launch.value}/${what}`, {
            method: 'POST', headers: {'Orrery-Actor': await load()},
        })
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = null
    }
}
</script>

<template>
  <div role="alertdialog" :aria-label="`${session.name} needs permission`" class="flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl bg-panel p-3 text-xs shadow-lg ring-1 ring-rose-500/40" data-permission-prompt>
    <div class="flex items-start gap-2">
      <p class="min-w-0 flex-1 text-[13px] font-medium text-fg">
        <NuxtLink :to="`/sessions#session-${session.id}`" class="hover:underline">{{ session.name }}</NuxtLink> needs permission
      </p>
      <UiButton variant="ghost" size="xs" square aria-label="Hide until it asks again" @click="emit('close')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </UiButton>
    </div>
    <pre v-if="prompt" class="max-h-64 overflow-auto rounded-lg bg-well p-2 font-mono text-[11px] leading-[1.35] text-fg ring-1 ring-line">{{ prompt }}</pre>
    <p v-if="session.asks" class="text-muted">{{ session.asks }}</p>
    <div v-if="launch" class="flex items-center gap-2">
      <UiButton variant="primary" size="xs" :disabled="!!busy" @click="act('allow')">{{ busy === 'allow' ? 'Allowing…' : 'Allow' }}</UiButton>
      <UiButton size="xs" :disabled="!!busy" @click="act('watch')">{{ busy === 'watch' ? 'Opening…' : 'Open tmux' }}</UiButton>
      <span class="text-faint">Allow says “Yes” once</span>
    </div>
    <p v-else class="text-faint">Started in a terminal: answer it there.</p>
    <p v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
