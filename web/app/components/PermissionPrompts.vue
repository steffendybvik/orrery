<script setup lang="ts">
import type {Session} from '#shared/roadmap'

// Every session at a permission prompt, popped up at the top right of any page (ORR-489), newest last, for the owner
// once they've named themselves. A session heard on several projects is shown once. One hidden (×) stays hidden until
// it asks again (a new `since`); the sidebar still says permission needed.
const {sessions} = useRoadmaps()
const {named} = useOwner()
// The chat's own shows in its pane while that's open (ORR-750).
const {open, session: chat} = useChat()
const hidden = ref(new Set<string>())
const key = (s: {id: string, since: string}) => `${s.id}@${s.since}`
const asking = computed(() => {
    const seen = new Map<string, Session>()
    for (const list of Object.values(sessions.value)) for (const s of list) if (s.state === 'waiting' && !seen.has(s.id) && !(open.value && chat.value?.id === s.id)) seen.set(s.id, s)
    return [...seen.values()].filter(s => !hidden.value.has(key(s))).sort((a, b) => a.since.localeCompare(b.since))
})
function hide(s: Session) {
    hidden.value = new Set([...hidden.value, key(s)])
}
</script>

<template>
  <div v-if="named && asking.length" class="fixed top-4 right-4 z-40 flex flex-col gap-2">
    <PermissionPrompt v-for="s in asking" :key="key(s)" :session="s" @close="hide(s)" />
  </div>
</template>
