<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// The live view of a session orrery started: its screen, as its launcher captures it, refreshed about once a second
// while this is shown and the tab is visible. Under it, a line and keys to type into it (ORR-1152), sized for a thumb,
// for a phone, where its terminal can't be attached: Enter sends the line into the terminal and presses Enter, and each
// key goes as it's pressed, for Claude Code's questions (the arrows, 1–4, Enter), Esc to interrupt and Ctrl-C.
const props = defineProps<{session: Session}>()
const {load} = useOwner()
const screen = ref<string | null>(null)
const at = ref('')
const failed = ref('')

/** The keys under the screen: what each shows, and what it sends. 1–4 pick one of Claude Code's choices. */
const KEYS: {label: string, title: string, send: {text?: string, keys?: string[]}}[] = [
    {label: 'Esc', title: 'Escape: interrupts what it is doing, or backs out of a question', send: {keys: ['Escape']}},
    {label: 'Tab', title: 'Tab', send: {keys: ['Tab']}},
    {label: '↑', title: 'Up', send: {keys: ['Up']}},
    {label: '↓', title: 'Down', send: {keys: ['Down']}},
    {label: 'Enter', title: 'Enter', send: {keys: ['Enter']}},
    ...['1', '2', '3', '4'].map(n => ({label: n, title: `Picks choice ${n}`, send: {text: n}})),
    {label: 'Ctrl-C', title: 'Ctrl-C', send: {keys: ['Ctrl-C']}},
]
const line = ref('')
const typing = ref(false)

/** Sends it into the terminal, then reads the screen again soon, so what it did shows. */
async function type(send: {text?: string, keys?: string[]}) {
    const launch = props.session.started?.launch
    if (!launch || typing.value) return
    typing.value = true
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.session.project)}/launches/${launch}/keys`, {method: 'POST', body: send, headers: {'Orrery-Actor': await load()}})
        failed.value = ''
        clearTimeout(timer)
        timer = setTimeout(poll, 300)
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        typing.value = false
    }
}

async function sendLine() {
    const text = line.value
    await type(text ? {text, keys: ['Enter']} : {keys: ['Enter']})
    if (!failed.value) line.value = ''
}

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
    <form class="flex items-center gap-2" @submit.prevent="sendLine">
      <input
          v-model="line"
          :aria-label="`Type into ${session.name}'s terminal`"
          :placeholder="`Type into ${session.name}…`"
          title="Enter sends it into its terminal and presses Enter"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="send"
          maxlength="2000"
          class="h-9 min-w-0 flex-1 rounded-lg bg-well px-3 font-mono text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
      >
      <UiButton type="submit" size="md" :disabled="typing">Send</UiButton>
    </form>
    <div class="flex flex-wrap gap-1.5" role="group" :aria-label="`Keys to press in ${session.name}'s terminal`">
      <UiButton v-for="key in KEYS" :key="key.label" size="md" :title="key.title" :disabled="typing" class="min-w-10 font-mono" @click="type(key.send)">{{ key.label }}</UiButton>
    </div>
    <p class="text-[11px]" :class="failed ? 'text-rose-700 dark:text-rose-400' : 'text-faint'">
      {{ failed || (at ? `As of ${new Date(at).toLocaleTimeString()} · what you type goes into its terminal` : 'What you type goes into its terminal') }}
    </p>
  </div>
</template>
