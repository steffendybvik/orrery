<script setup lang="ts">
// The first time an Orrery is opened, it asks whose it is. That name is the owner's (what they make,
// no one else can delete), and their `Orrery-Actor` is it in lowercase snake case.
const {named, rename} = useOwner()
const display = ref('')
const saving = ref(false)
const failed = ref('')
const input = ref<HTMLInputElement | null>(null)
watch(named, now => {
    if (!now) nextTick(() => input.value?.focus())
}, {immediate: true})

/** As the server makes it: `Sköll Fenrisson` → `skoll_fenrisson`. */
const id = computed(() => display.value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
const ready = computed(() => !!id.value && id.value !== 'agent' && !saving.value)

async function save() {
    if (!ready.value) return
    saving.value = true
    failed.value = ''
    try {
        await rename(display.value.trim())
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="!named" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[16vh] backdrop-blur-[2px]">
      <form class="glass flex w-full max-w-md animate-fade-up flex-col gap-3 rounded-2xl p-5" role="dialog" aria-label="Your name" @submit.prevent="save">
        <div class="flex flex-col gap-1">
          <h2 class="text-[15px] font-semibold text-fg">Whose Orrery is this?</h2>
          <p class="text-xs text-muted">You're its owner: what you make, no one else can delete. Change it later in Settings.</p>
        </div>
        <input ref="input" v-model="display" placeholder="Your name" aria-label="Your name" maxlength="60" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
        <p class="text-xs text-faint">
          Your <span class="font-mono text-muted">Orrery-Actor</span> header will be <span class="font-mono text-muted">{{ id || 'your_name' }}</span>
        </p>
        <div class="flex items-center gap-2 border-t border-line pt-3">
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <span v-else-if="id === 'agent'" class="text-xs text-rose-600 dark:text-rose-400">"agent" is what requests without a name are; pick another.</span>
          <button type="submit" class="ml-auto flex h-8 items-center rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!ready">
            {{ saving ? 'Saving…' : 'Continue' }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
