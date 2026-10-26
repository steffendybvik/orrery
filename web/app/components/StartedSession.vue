<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {TERMINALS} from '#shared/roadmap'

// A session Orrery started, beside its row: how long it has left (or that it runs until stopped), Watch (its launcher
// opens a terminal on it) with the command that attaches to its tmux session to copy, and the owner's +30 min (for
// one with a time) and Stop.
const props = defineProps<{session: Session}>()
const {load} = useOwner()
const busy = ref<'stop' | 'extend' | 'watch' | null>(null)
const {settings} = useAppSettings()
const failed = ref('')

// Ticks once a minute, so the time left stays right on an open page.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => timer = setInterval(() => now.value = Date.now(), 60_000))
onBeforeUnmount(() => clearInterval(timer))
const left = computed(() => {
    const stopsAt = props.session.started!.stops_at
    if (!stopsAt) return 'running'
    const minutes = Math.round((Date.parse(stopsAt) - now.value) / 60_000)
    // Past its time, it's waiting to finish what it's on.
    if (minutes <= 0) return 'stops when done'
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`
})

async function act(what: 'stop' | 'extend' | 'watch') {
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
    <span :title="session.started.stops_at ? `Orrery started it; it stops at ${new Date(session.started.stops_at).toLocaleTimeString()}, or once it's done after that` : 'Orrery started it; it runs until stopped'">started · {{ left }}</span>
    <button
        type="button"
        class="h-6 rounded-md px-1.5 text-[11px] ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50"
        :disabled="!!busy"
        :title="`Open ${TERMINALS[settings.terminal]} on ${session.name}, on its launcher's machine`"
        @click="act('watch')"
    >
      {{ busy === 'watch' ? 'Opening…' : 'Watch' }}
    </button>
    <CopyButton :text="`tmux attach -t ${session.started.tmux}`" label="" :name="`tmux attach -t ${session.started.tmux}`" />
    <button v-if="session.started.stops_at" type="button" class="h-6 rounded-md px-1.5 text-[11px] ring-1 ring-line hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="!!busy" title="Give it 30 more minutes" @click="act('extend')">+30 min</button>
    <button type="button" class="h-6 rounded-md px-1.5 text-[11px] text-rose-600 ring-1 ring-rose-500/40 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-400" :disabled="!!busy" :title="`Stop ${session.name} now`" @click="act('stop')">{{ busy === 'stop' ? 'Stopping…' : 'Stop' }}</button>
    <span v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</span>
  </span>
</template>
