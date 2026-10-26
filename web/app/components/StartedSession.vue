<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// A session Orrery started, beside its row: how long it has left, the command that attaches to its tmux
// session to watch it, and the owner's +30 min and Stop.
const props = defineProps<{session: Session}>()
const {load} = useOwner()
const busy = ref<'stop' | 'extend' | null>(null)
const failed = ref('')

// Ticks once a minute, so the time left stays right on an open page.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => timer = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(timer))
const left = computed(() => {
    const minutes = Math.max(0, Math.round((Date.parse(props.session.started!.stops_at) - now.value) / 60_000))
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`
})

async function act(what: 'stop' | 'extend') {
    busy.value = what
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.session.project)}/launches/${props.session.started!.launch}/${what}`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: what === 'extend' ? {minutes: 30} : {},
        })
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = null
    }
}
</script>

<template>
  <span v-if="session.started" class="flex shrink-0 items-center gap-1.5 text-xs text-faint">
    <span :title="`Orrery started it; it stops at ${new Date(session.started.stops_at).toLocaleTimeString()}`">started · {{ left }}</span>
    <CopyButton :text="`tmux attach -t ${session.started.tmux}`" label="Watch" :name="`tmux attach -t ${session.started.tmux}`" />
    <button type="button" class="h-6 rounded-md px-1.5 text-[11px] ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="!!busy" title="Give it 30 more minutes" @click="act('extend')">+30 min</button>
    <button type="button" class="h-6 rounded-md px-1.5 text-[11px] text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400" :disabled="!!busy" :title="`Stop ${session.name} now`" @click="act('stop')">{{ busy === 'stop' ? 'Stopping…' : 'Stop' }}</button>
    <span v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</span>
  </span>
</template>
