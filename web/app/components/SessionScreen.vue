<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The live view of a session orrery started: its screen, as its launcher captures it, refreshed about once a second
// while this is shown and the tab is visible. Read only: nothing goes into the session.
const props = defineProps<{session: Session}>()
const {load} = useOwner()
const screen = ref<string | null>(null)
const at = ref('')
const failed = ref('')

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
async function poll() {
    if (stopped) return
    const launch = props.session.started?.launch
    if (launch && document.visibilityState === 'visible') {
        try {
            const shot = await apiFetch<{screen: string | null, at?: string}>(
                `/projects/${encodeURIComponent(props.session.project)}/launches/${launch}/screen`,
                {headers: {'Orrery-Actor': await load()}},
            )
            // Trailing blank lines and spaces are the pane's empty part.
            screen.value = shot.screen?.replace(/[ \t]+$/gm, '').replace(/\n+$/, '') ?? null
            at.value = shot.at ?? ''
            failed.value = ''
        } catch (error) {
            failed.value = errorMessage(error)
        }
    }
    if (!stopped) timer = setTimeout(poll, 1000)
}
onMounted(poll)
onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <pre
        class="max-h-[28rem] min-h-24 overflow-auto rounded-lg bg-well p-3 font-mono text-[11px] leading-[1.35] text-fg ring-1 ring-line"
        :aria-label="`${session.name}'s screen`"
    >{{ screen ?? (failed ? '' : 'Waiting for the launcher to send the screen…') }}</pre>
    <p class="text-[11px]" :class="failed ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">
      {{ failed || (at ? `Read only · as of ${new Date(at).toLocaleTimeString()}` : 'Read only') }}
    </p>
  </div>
</template>
