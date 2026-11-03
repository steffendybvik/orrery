<script setup lang="ts">
// The front door when auth is on (ORR-664): the server is what enforces it. Log in through the provider, or with a person
// key on a server with none. Nothing here reads the board, as nothing else on the page has started.
definePageMeta({layout: false})
useHead({title: 'Log in'})

const {status} = useAuth()
const route = useRoute()
const invite = computed(() => typeof route.query.invite === 'string' ? route.query.invite : '')
const provider = computed(() => apiUrl(`/auth/oidc/start${invite.value ? `?invite=${encodeURIComponent(invite.value)}` : ''}`))
const key = ref('')
const busy = ref(false)
const failed = ref('')

async function submit() {
    busy.value = true
    failed.value = ''
    try {
        // With no owner to name yet: nobody's logged in to ask.
        await apiFetch('/auth/login', {method: 'POST', headers: {}, body: {key: key.value}})
        location.assign('/')
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <main class="flex min-h-dvh items-center justify-center p-6">
    <div class="flex w-96 max-w-full flex-col gap-4">
      <h1 class="text-[15px] font-semibold text-fg">Log in to this orrery</h1>
      <p v-if="status?.mode === 'closed'" class="text-xs text-rose-700 dark:text-rose-400">
        ORRERY_AUTH=off only works while orrery listens on loopback, and this one is reachable from other machines. Unset it, and restart.
      </p>
      <p v-else-if="status && !status.can_get_in" class="text-xs text-muted">
        Nobody can log in yet. On the machine it runs on, run <code class="font-mono">pnpm orrery:claim</code>
        (or <code class="font-mono">docker compose exec orrery node /app/server/claim.mjs</code>), and sign in with the key it prints.
      </p>
      <p v-if="status?.warn_http" class="text-xs text-amber-800 dark:text-amber-300">
        This is plain http: over anything but a VPN, a person key and this login's cookie can travel unencrypted.
      </p>
      <UiButton v-if="status?.oidc" :to="provider" variant="primary" size="md" external>Log in with your provider</UiButton>
      <form v-if="status?.mode !== 'closed'" class="flex flex-col gap-2" @submit.prevent="submit">
        <input
            v-model="key"
            type="password"
            aria-label="Person key"
            placeholder="Person key"
            autocomplete="off"
            spellcheck="false"
            class="h-8 w-full field font-mono"
        >
        <UiButton type="submit" :variant="status?.oidc ? 'secondary' : 'primary'" size="md" :disabled="busy || !key.trim()">Sign in with a key</UiButton>
      </form>
      <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    </div>
  </main>
</template>
