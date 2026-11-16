<script setup lang="ts">
// Who this browser is signed in as, with Sign out at hand (ORR-1268): only with login on and someone signed in, as
// Settings → You → Account is a long way to go for it.
const {status, logOut} = useAuth()
const {nameOf} = usePeople()
const person = computed(() => status.value?.mode === 'on' && status.value.via === 'browser' ? status.value.person : undefined)
const name = computed(() => person.value && nameOf(person.value))
const leaving = ref(false)

async function signOut() {
    leaving.value = true
    try {
        await logOut()
    } finally {
        leaving.value = false
    }
}
</script>

<template>
  <div v-if="person" class="mt-1.5 flex items-center gap-2 px-2 text-[11px] text-muted">
    <span class="min-w-0 flex-1 truncate" :title="`Signed in as ${name}`">Signed in as <span class="text-fg">{{ name }}</span></span>
    <button type="button" class="shrink-0 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg disabled:opacity-50" :disabled="leaving" @click="signOut">Sign out</button>
  </div>
</template>
