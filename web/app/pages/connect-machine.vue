<script setup lang="ts">
// Where the install line sends someone to connect their computer (ORR-1192), signed in: it names the machine and shows
// the words the Terminal shows, and Connect gives that machine a key of theirs, reaching every workspace they're in. The
// launcher, waiting in the Terminal, picks it up by itself. Written for someone who isn't a developer.
useHead({title: 'Connect a computer'})

interface Asked {name: string, words: string, expires_at: string, approved: boolean}
const route = useRoute()
const request = computed(() => typeof route.query.request === 'string' ? route.query.request : '')
const asked = ref<Asked | null>(null)
const failed = ref('')
const busy = ref(false)
const done = ref(false)

onMounted(async () => {
    if (!request.value) {
        failed.value = 'This page is opened by the line you paste in the Terminal app. Run it there, and it brings you back here.'
        return
    }
    try {
        asked.value = await apiFetch<Asked>(`/machines/requests/${encodeURIComponent(request.value)}`)
        done.value = asked.value.approved
    } catch (error) {
        failed.value = errorMessage(error)
    }
})

async function connect() {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/machines/requests/${encodeURIComponent(request.value)}/approve`, {method: 'POST'})
        done.value = true
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <main class="mx-auto flex max-w-md flex-col gap-4 px-4 py-[12vh]" data-testid="connect-machine">
    <h1 class="text-xl font-semibold text-fg">{{ done ? 'Connected' : 'Connect a computer' }}</h1>

    <template v-if="asked && !done">
      <p class="text-[13px] text-muted">
        <span class="font-medium text-fg">{{ asked.name }}</span> is asking to connect to your orrery, so Claude on it can pick up your work, in every workspace you're in.
      </p>
      <div class="flex flex-col gap-1 rounded-lg p-3 ring-1 ring-line">
        <span class="text-xs text-muted">Check the Terminal shows the same:</span>
        <span class="font-mono text-lg font-semibold tracking-wider text-fg" data-testid="connect-machine-words">{{ asked.words }}</span>
      </div>
      <p class="text-xs text-muted">Didn't run the line yourself just now, or the words don't match? Close this page.</p>
      <UiButton variant="primary" size="md" class="self-start" :disabled="busy" data-testid="connect-machine-go" @click="connect">
        <UiBusy :busy="busy" label="Connecting…">Connect {{ asked.name }}</UiBusy>
      </UiButton>
    </template>

    <p v-else-if="done" class="text-[13px] text-muted">
      <span class="font-medium text-fg">{{ asked?.name ?? 'Your computer' }}</span> is connected. Go back to the Terminal app: it finishes setting up by itself. You can disconnect it any time in Settings → You → Your keys.
    </p>

    <p v-if="failed" class="text-[13px] text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </main>
</template>
