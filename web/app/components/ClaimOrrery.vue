<script setup lang="ts">
// Claiming this orrery from its page (ORR-832), on App settings → You and on the login page: shown only while the server
// says this page may (`can_claim`: on this machine, nobody has a person key). It makes the owner's person key and an
// agent key for this machine, each shown this once, and signs this browser in. The server can't write keys.json, which
// is on this machine and not in its container, so what's left is said in words, with a line that does it.
const emit = defineEmits<{done: []}>()
const {status} = useAuth()
const name = ref('')
const busy = ref(false)
const failed = ref('')
const claimed = ref<{person_key: {key: string}, agent_key: {key: string}} | null>(null)
const here = import.meta.client ? location.origin : ''

async function claim() {
    busy.value = true
    failed.value = ''
    try {
        claimed.value = await apiFetch('/auth/claim', {method: 'POST', body: status.value?.named ? {} : {name: name.value}})
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}

/** Adds the agent key to ~/.config/orrery/keys.json for this address, keeping what's there, readable by you alone. */
const keysLine = computed(() => claimed.value ? `node -e 'const fs=require("fs"),p=require("path"),f=p.join(process.env.XDG_CONFIG_HOME||p.join(require("os").homedir(),".config"),"orrery","keys.json");let k={};try{k=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}k[process.argv[1]]=process.argv[2];fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(k,null,2)+"\\n",{mode:0o600});fs.chmodSync(f,0o600)' '${here}' '${claimed.value.agent_key.key}'` : '')
</script>

<template>
  <div class="flex flex-col gap-3">
    <form v-if="!claimed" class="flex flex-wrap items-center gap-2" @submit.prevent="claim">
      <input v-if="!status?.named" v-model="name" aria-label="Your name" placeholder="Your name" maxlength="60" class="h-8 w-56 max-w-full field">
      <UiButton type="submit" variant="primary" size="md" :disabled="busy || (!status?.named && !name.trim())">Claim this orrery</UiButton>
    </form>
    <template v-else>
      <p class="text-xs text-muted">
        Claimed, and this browser is signed in. Each key is shown this once: copy them now. Only a hash is kept.
      </p>
      <CopyBlock title="Person key" :text="claimed.person_key.key" hint="Sign in with it on your phone, or any browser off this machine. Keep it safe, and never put it in a session's environment." />
      <CopyBlock title="Agent key, for this machine's sessions" :text="claimed.agent_key.key" hint="Your channel, hooks and launcher send it once login is on." />
      <CopyBlock title="Put the agent key in keys.json" :text="keysLine" :hint="`Run it in a terminal on this machine: it adds the key for ${here} to ~/.config/orrery/keys.json, readable by you alone. orrery can't write that file itself, as it runs in a container.`" />
      <p class="text-xs text-muted">
        Then open it up: set <code class="font-mono">ORRERY_HOST</code> and run <code class="font-mono">docker compose up -d</code> again.
        Your sessions already have their key, so they carry on. If they'll reach orrery at another address after that
        (a VPN's, say), run the line again with that address in place of <code class="font-mono">{{ here }}</code>.
      </p>
      <div>
        <UiButton @click="emit('done')">Done</UiButton>
      </div>
    </template>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
