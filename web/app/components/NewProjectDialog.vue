<script setup lang="ts">
// Starting a project, as the owner (so agents can't delete it): its name, the key its issue ids start
// with (LAR-1) and its id in addresses, both suggested from the name until changed, and a line about
// it. ⌘↵ creates it and opens it, Esc closes.
const shown = useState('new-project', () => false)
const {load} = useOwner()
const router = useRouter()

const name = ref('')
const key = ref('')
const id = ref('')
const description = ref('')
const keyTouched = ref(false)
const idTouched = ref(false)
const saving = ref(false)
const failed = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

/** As the server makes them: a slug, and three capitals from the name. */
const slugify = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
const keyFor = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 3)

watch(shown, now => {
    if (!now) return
    name.value = key.value = id.value = description.value = failed.value = ''
    keyTouched.value = idTouched.value = false
    nextTick(() => nameInput.value?.focus())
}, {immediate: true})
watch(name, now => {
    if (!keyTouched.value) key.value = keyFor(now)
    if (!idTouched.value) id.value = slugify(now)
})

const keyOk = computed(() => /^[A-Z][A-Z0-9]{0,9}$/.test(key.value))
const idOk = computed(() => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id.value))
const ready = computed(() => !!name.value.trim() && keyOk.value && idOk.value && !saving.value)

async function create() {
    if (!ready.value) return
    saving.value = true
    failed.value = ''
    try {
        await $fetch('/api/projects', {
            method: 'POST',
            headers: {'Orrery-Actor': await load()},
            body: {name: name.value.trim(), key: key.value, id: id.value, ...description.value.trim() ? {description: description.value.trim()} : {}},
        })
        shown.value = false
        router.push(`/p/${id.value}`)
    } catch (error) {
        failed.value = errorMessage(error, 'create')
    } finally {
        saving.value = false
    }
}

const field = 'h-8 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <Teleport to="body">
    <div v-if="shown" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" @pointerdown.self="shown = false">
      <form class="glass flex w-full max-w-lg animate-fade-up flex-col gap-3 rounded-2xl p-5" role="dialog" aria-label="New project" @submit.prevent="create" @keydown.esc.stop="shown = false" @keydown.meta.enter.prevent="create" @keydown.ctrl.enter.prevent="create">
        <div class="flex items-center gap-2 text-xs text-faint">
          <span>New project</span>
          <KeyHint class="ml-auto">esc</KeyHint>
        </div>
        <input ref="nameInput" v-model="name" placeholder="Project name, e.g. Larder" aria-label="Name" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
        <input v-model="description" placeholder="What it is, in a line (optional)" aria-label="Description" class="bg-transparent text-[14px] text-fg placeholder:text-faint focus:outline-none">
        <div class="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <label class="flex flex-col gap-1 text-xs text-muted">
            Key
            <input v-model="key" aria-label="Key" :class="[field, 'w-24 font-mono uppercase', key && !keyOk && 'ring-rose-500/60']" @input="keyTouched = true; key = key.toUpperCase()">
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Id
            <input v-model="id" aria-label="Id" :class="[field, 'w-48 font-mono', id && !idOk && 'ring-rose-500/60']" @input="idTouched = true">
          </label>
          <p class="min-w-0 flex-1 pb-1.5 text-xs text-faint">
            Issues will be <span class="font-mono text-muted">{{ keyOk ? key : 'KEY' }}-1</span>, at <span class="font-mono text-muted">/p/{{ idOk ? id : 'id' }}</span>
          </p>
        </div>
        <p v-if="key && !keyOk" class="text-xs text-rose-600 dark:text-rose-400">The key is capitals and digits, starting with a capital (up to 10), e.g. LAR.</p>
        <p v-if="id && !idOk" class="text-xs text-rose-600 dark:text-rose-400">The id is lowercase letters, digits and dashes, e.g. my-app.</p>
        <div class="flex items-center gap-2">
          <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <button type="submit" class="ml-auto flex h-8 items-center gap-2 rounded-lg bg-accent-500 px-3.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40" :disabled="!ready">
            {{ saving ? 'Creating…' : 'Create project' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
