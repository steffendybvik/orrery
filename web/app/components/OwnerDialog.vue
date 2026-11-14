<script setup lang="ts">
// The first time an orrery is opened, it asks whose it is. That name is the owner's (what they make,
// no one else can delete), and their `Orrery-Actor` is it in lowercase snake case. Where its data is kept is set as
// orrery starts (ORRERY_DATABASE), not here.
// With the name it asks whether they're a developer (ORR-579): a no turns Advanced off (App settings → Advanced), so the
// sidebar leaves out Events, Context and Pull requests and orrery records only its errors.
const {named, rename} = useOwner()
const {settings, save: saveSettings} = useAppSettings()
const display = ref('')
const developer = ref(true)
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
        if (!developer.value && settings.value.advanced) await saveSettings({advanced: false})
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <UiDialog
      :open="!named"
      name="owner-setup"
      label="Your name"
      width="md"
      required
      @submit="save"
  >
    <div class="flex flex-col gap-1">
      <h2 class="text-[15px] font-semibold text-fg">Whose orrery is this?</h2>
      <p class="text-xs text-muted">You're its owner: what you make, no one else can delete. Change it later in Settings.</p>
    </div>
    <input ref="input" v-model="display" placeholder="Your name" aria-label="Your name" maxlength="60" class="bg-transparent text-lg font-semibold text-fg placeholder:text-faint focus:outline-none">
    <fieldset class="flex flex-col gap-1.5">
      <legend class="mb-1.5 text-[13px] font-medium text-fg">Are you a developer?</legend>
      <div class="flex gap-2">
        <label
            v-for="{value, label, note} in [{value: true, label: 'Yes', note: 'Show the pages for looking into problems'}, {value: false, label: 'No', note: 'Keep them out of the sidebar'}]"
            :key="label"
            class="flex flex-1 cursor-pointer items-start gap-2 rounded-lg p-2 ring-1 hover:bg-hover"
            :class="developer === value ? 'ring-accent-500/50' : 'ring-line'"
        >
          <input v-model="developer" type="radio" name="developer" :value="value" class="mt-0.5 accent-accent-fill">
          <span class="flex flex-col gap-0.5">
            <span class="text-[13px] font-medium text-fg">{{ label }}</span>
            <span class="text-xs text-muted">{{ note }}</span>
          </span>
        </label>
      </div>
      <p class="text-xs text-faint">Those are Events, Context and Pull requests. Change it later in App settings → Advanced.</p>
    </fieldset>
    <p class="text-xs text-faint">
      Your <span class="font-mono text-muted">Orrery-Actor</span> header will be <span class="font-mono text-muted">{{ id || 'your_name' }}</span>
    </p>
    <div class="flex items-center gap-2 border-t border-line pt-3">
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</span>
      <span v-else-if="id === 'agent'" class="text-xs text-rose-700 dark:text-rose-400">"agent" is what requests without a name are; pick another.</span>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="!ready">
        <UiBusy :busy="saving" label="Saving…">Continue</UiBusy>
      </UiButton>
    </div>
  </UiDialog>
</template>
