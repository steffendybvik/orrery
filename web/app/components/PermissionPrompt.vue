<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {listable} from '#shared/roadmap'

// A session at a permission prompt pops up on whatever page the owner has open (ORR-489), small: Claude Code's line on
// what it wants, the command or file from its prompt in one line for one orrery started (the whole prompt on hover; its
// screen stays in tmux), and without a screen the tool it asks for with the command, file or address (ORR-562: its hook
// says, so the notification's line needn't). The screen comes first: it's what Allow answers, and anything can post a
// session's hook (ORR-572). With Allow (its launcher answers "Yes" once, only while the prompt is still
// there) and Open tmux (Watch). One started by hand has no tmux orrery knows, so it says what it wants without the
// buttons, and without the channel has no card for its name to link to (ORR-716). It goes once the session moves on; × hides it until it asks again.
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
            const shot = await apiFetch<{screen: string | null}>(
                `/projects/${encodeURIComponent(props.session.project)}/launches/${launch.value}/screen`,
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
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/launches/${launch.value}/${what}`, {
            method: 'POST',
        })
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = null
    }
}
</script>

<template>
  <div role="alertdialog" :aria-label="`${session.name} needs permission`" class="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-xl bg-panel p-2.5 text-xs shadow-lg ring-1 ring-rose-500/40" data-permission-prompt>
    <div class="flex items-start gap-2">
      <p class="min-w-0 flex-1 truncate font-medium text-fg">
        <NuxtLink v-if="listable(session)" :to="`/sessions#session-${session.id}`" class="hover:underline">{{ session.name }}</NuxtLink><template v-else>{{ session.name }}</template> needs permission
      </p>
      <UiButton variant="ghost" size="xs" square aria-label="Hide until it asks again" @click="emit('close')">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </UiButton>
    </div>
    <p v-if="session.asks" class="text-muted">{{ session.asks }}</p>
    <p v-if="prompt?.what" class="truncate rounded-md bg-well px-2 py-1 font-mono text-[11px] text-fg" :title="prompt.text">{{ prompt.what }}</p>
    <p v-else-if="session.asking" class="flex min-w-0 items-baseline gap-1.5" data-asking>
      <span class="shrink-0 font-medium text-fg">{{ toolLabel(session.asking.name) }}</span>
      <span v-if="session.asking.detail" class="min-w-0 truncate rounded-md bg-well px-2 py-1 font-mono text-[11px] text-fg" :title="session.asking.detail">{{ session.asking.detail }}</span>
    </p>
    <div v-if="launch" class="flex items-center gap-2">
      <UiButton variant="primary" size="xs" :disabled="!!busy" title="Answers “Yes” once" @click="act('allow')">{{ busy === 'allow' ? 'Allowing…' : 'Allow' }}</UiButton>
      <UiButton size="xs" :disabled="!!busy" @click="act('watch')">{{ busy === 'watch' ? 'Opening…' : 'Open tmux' }}</UiButton>
    </div>
    <p v-else class="text-faint">Started in a terminal: answer it there.</p>
    <p v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
