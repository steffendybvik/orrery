<script setup lang="ts">
// The front door when auth is on (ORR-664): the server is what enforces it. Log in through the provider, or with a person
// key on a server with none: with a provider there's only its button (ORR-1185), as a key box is one more thing to ask
// someone who isn't a developer about. Nothing here reads the board, as nothing else on the page has started.
definePageMeta({layout: false})
useHead({title: 'Log in'})

const {status} = useAuth()
const route = useRoute()
const invite = computed(() => typeof route.query.invite === 'string' ? route.query.invite : '')
// A page hosted apart from its server (ORR-667) asks the provider's way back to come here, which the server allows only for
// an origin it lists.
// `someoneElse` asks the provider for its login form even while it's signed in (ORR-1319), to pick another account.
function providerUrl(someoneElse: boolean) {
    const query = new URLSearchParams({
        ...invite.value ? {invite: invite.value} : {},
        ...import.meta.client && apiCrossOrigin('/auth/oidc/start') ? {back: location.origin} : {},
        ...someoneElse ? {someone_else: '1'} : {},
    }).toString()
    return apiUrl(`/auth/oidc/start${query ? `?${query}` : ''}`)
}
const provider = computed(() => providerUrl(false))
const someoneElse = computed(() => providerUrl(true))
const key = ref('')
const busy = ref(false)
const failed = ref('')

// A one-time link from App settings' QR code (ORR-837): it signs this browser in, nothing to type.
const link = typeof route.query.t === 'string' ? route.query.t : ''
const linking = ref(!!link)
onMounted(async () => {
    if (!link) return
    try {
        await apiFetch('/auth/link', {method: 'POST', headers: {}, body: {token: link}})
        location.replace('/')
    } catch (error) {
        failed.value = errorMessage(error)
        linking.value = false
        history.replaceState(null, '', '/login')
    }
})

// The six letters App settings shows under the QR code (ORR-875): the way in from an app on the home screen, which keeps
// cookies apart from the browser's and has no camera to scan with.
const code = ref('')
const codeTyped = computed(() => code.value.replace(/[\s-]/g, '').length === 6)
async function submitCode() {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch('/auth/link', {method: 'POST', headers: {}, body: {code: code.value}})
        location.replace('/')
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}

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
  <!-- The front door looks like orrery (ORR-1291): its mark and name, a line on what it is, and one clear way in, on a
       card over a faint orbit, the logo's drawn large. -->
  <main class="relative isolate flex min-h-dvh items-center justify-center overflow-hidden p-4 sm:p-6">
    <div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_45%_at_50%_0%,color-mix(in_oklab,var(--color-accent-500)_14%,transparent),transparent)]" />
    <OrreryMark class="pointer-events-none absolute -right-40 -bottom-40 -z-10 size-[34rem] text-accent-500/[0.06] sm:-right-24 sm:-bottom-24 dark:text-accent-400/[0.07]" />
    <div class="flex w-full max-w-sm animate-fade-up flex-col gap-6 rounded-2xl border border-line bg-panel p-6 shadow-xl shadow-black/5 sm:p-8 dark:shadow-black/40">
      <header class="flex flex-col items-center gap-4 text-center">
        <div class="flex items-center gap-2.5">
          <div class="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-tile-from to-tile-to shadow-lg shadow-accent-600/30">
            <OrreryMark class="size-5 text-white" />
          </div>
          <span class="text-lg font-semibold tracking-tight text-fg">orrery</span>
        </div>
        <div class="flex flex-col gap-1.5">
          <h1 class="text-xl font-semibold tracking-tight text-fg">Log in to this orrery</h1>
          <p class="text-[13px] text-balance text-muted">The roadmap you share with your Claude Code sessions: you write the issues, they pick them up and ask when they need you.</p>
        </div>
      </header>
      <div class="flex flex-col gap-4">
        <p v-if="linking" class="flex items-center gap-2 text-xs text-muted"><UiSpinner />Signing you in…</p>
        <p v-if="status?.mode === 'closed'" class="text-xs text-rose-700 dark:text-rose-400">
          ORRERY_AUTH=off only works while orrery listens on loopback, and this one is reachable from other machines. Unset it, and restart.
        </p>
        <p v-else-if="status?.phone && !linking" class="text-xs text-muted">
          On your computer, open orrery's App settings → You and scan its QR code with this phone's camera: that signs you in.
          Or type the code shown under it here.
        </p>
        <form v-if="status?.phone && !linking" class="flex flex-col gap-2" @submit.prevent="submitCode">
          <input
              v-model="code"
              aria-label="Code from your computer"
              placeholder="Code, e.g. KQ7-M4X"
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="9"
              class="h-8 w-full field font-mono uppercase tracking-widest placeholder:normal-case placeholder:tracking-normal"
          >
          <UiButton type="submit" variant="primary" size="md" :disabled="busy || !codeTyped">Sign in with the code</UiButton>
        </form>
        <p v-else-if="status && !status.can_get_in" class="text-xs text-muted">
          Nobody can log in yet. On the machine it runs on, run <code class="font-mono">pnpm orrery:claim</code>
          (or <code class="font-mono">docker compose exec orrery node /app/server/claim.mjs</code>), and sign in with the key it prints.
        </p>
        <p v-if="status?.warn_http" class="text-xs text-amber-800 dark:text-amber-300">
          This is plain http: over anything but a VPN, a person key and this login's cookie can travel unencrypted.
        </p>
        <!-- With sign-up open the provider's button lets someone new in too, so it says so (docs/running.md, ORRERY_SIGN_UP). -->
        <div v-if="status?.oidc" class="flex flex-col gap-2">
          <UiButton :to="provider" variant="primary" size="md" class="w-full" external>{{ status.sign_up ? 'Sign in or sign up' : 'Log in with your provider' }}</UiButton>
          <p v-if="status.sign_up && !invite" class="text-center text-xs text-balance text-faint">New here? Signing in makes you a workspace of your own.</p>
          <p v-else-if="invite" class="text-center text-xs text-faint">You've been invited: sign in to join.</p>
          <a :href="someoneElse" class="text-center text-xs text-muted underline-offset-2 hover:text-fg hover:underline">Sign in as someone else</a>
        </div>
        <form v-if="status?.mode !== 'closed' && !status?.oidc" class="flex flex-col gap-2" @submit.prevent="submit">
          <input
              v-model="key"
              type="password"
              aria-label="Person key"
              placeholder="Person key"
              autocomplete="off"
              spellcheck="false"
              class="h-8 w-full field font-mono"
          >
          <UiButton type="submit" :variant="status?.phone ? 'secondary' : 'primary'" size="md" :disabled="busy || !key.trim()">Sign in with a key</UiButton>
        </form>
        <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      </div>
    </div>
  </main>
</template>
