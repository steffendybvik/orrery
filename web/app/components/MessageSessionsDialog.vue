<script setup lang="ts">
import type {Session, SessionState, Signal} from '#shared/roadmap'

// The owner's own words to every listening session at once (`POST /api/sessions/message`), each hearing it as a
// message to it alone: idle ones unless more states are ticked, so a nudge doesn't interrupt work, on the projects
// ticked (every one with none). A session hearing several projects is one recipient. It starts no sessions.
const props = defineProps<{open: boolean}>()
const emit = defineEmits<{close: []}>()
const {sessions} = useRoadmaps()
const {ordered} = useProjectOrder()

const STATES: {id: SessionState, label: string}[] = [
    {id: 'idle', label: 'Idle'},
    {id: 'working', label: 'Working'},
    {id: 'waiting', label: 'Waiting on you'},
]
const text = ref('')
const projects = ref<string[]>([])
const states = ref<SessionState[]>(['idle'])
const busy = ref(false)
const failed = ref('')
const sent = ref<string[] | null>(null)

watch(() => props.open, now => {
    if (!now) return
    text.value = failed.value = ''
    projects.value = []
    states.value = ['idle']
    sent.value = null
})

/** Every listening session, once. */
const listening = computed(() => {
    const seen = new Map<string, Session>()
    for (const list of Object.values(sessions.value)) for (const s of list) if (s.listening) seen.set(s.id, s)
    return [...seen.values()]
})
/** The projects with a session listening on them, to tick. */
const heard = computed(() => ordered.value.filter(p => listening.value.some(s => s.project === p.id || s.also?.includes(p.id))))
/** Who it reaches, as the server picks them. */
const reached = computed(() => listening.value.filter(s => states.value.includes(s.state)
    && (!projects.value.length || projects.value.some(p => s.project === p || s.also?.includes(p)))))

function toggle(state: SessionState) {
    states.value = states.value.includes(state) ? states.value.filter(s => s !== state) : [...states.value, state]
}

/** Enter sends (⌘ or Ctrl-Enter too, through the dialog); Shift-Enter is a new line, and nothing sends while an input
 * method is still composing. */
function onEnter(event: KeyboardEvent) {
    if (event.isComposing) return
    event.preventDefault()
    send()
}

async function send() {
    const message = text.value.trim()
    if (!message || !states.value.length || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        const {sent: to} = await apiFetch<{sent: {name: string, signal: Signal}[]}>('/sessions/message', {
            method: 'POST',
            body: {text: message, states: states.value, ...projects.value.length ? {projects: projects.value} : {}},
        })
        sent.value = to.map(s => s.name)
        text.value = ''
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <UiDialog :open="open" label="Message sessions" @close="emit('close')" @submit="send">
    <div class="flex items-center gap-2 text-xs text-faint">
      <span>Message every session at once</span>
      <KeyHint class="ml-auto">esc</KeyHint>
    </div>

    <textarea
        v-model="text"
        rows="3"
        aria-label="Message"
        placeholder="e.g. If you're free, pick the most urgent Todo issue on your project"
        class="w-full field py-2 leading-5"
        @keydown.enter.exact="onEnter"
    />

    <div class="flex flex-col gap-1.5">
      <span class="label px-1">Sessions that are</span>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="States">
        <button
            v-for="s in STATES"
            :key="s.id"
            type="button"
            :aria-pressed="states.includes(s.id)"
            class="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1"
            :class="states.includes(s.id) ? 'bg-accent-500/10 text-fg ring-accent-500/40' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
            @click="toggle(s.id)"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <div v-if="heard.length > 1" class="flex flex-col gap-1">
      <span class="label px-1">On <span class="font-normal normal-case text-faint">· every project with none ticked</span></span>
      <div class="flex flex-col gap-0.5" role="group" aria-label="Projects">
        <label
            v-for="p in heard"
            :key="p.id"
            class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px]"
            :class="projects.includes(p.id) ? 'bg-accent-500/10 text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
        >
          <input v-model="projects" type="checkbox" name="project" :value="p.id" class="accent-accent-fill">
          <ProjectIcon v-if="p.icon && heroicon(p.icon)" :icon="p.icon" :color="p.icon_color" class="size-3.5" />
          <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
        </label>
      </div>
    </div>

    <div class="flex items-center gap-2 border-t border-line pt-3">
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
      <span v-else-if="sent" class="text-xs text-muted" role="status">
        {{ sent.length ? `Sent to ${sent.join(', ')}` : 'Nobody was there to hear it' }}
      </span>
      <span v-else class="truncate text-xs text-faint">
        {{ reached.length ? `Reaches ${reached.map(s => s.name).join(', ')}` : 'No session like that is listening' }}
      </span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto shrink-0" :disabled="!text.trim() || !states.length || busy">
        {{ busy ? 'Sending…' : `Send${reached.length ? ` to ${reached.length}` : ''}` }} <KeyHint class="bg-black/10 text-on-accent ring-0">↵</KeyHint>
      </UiButton>
    </div>
  </UiDialog>
</template>
