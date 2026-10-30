<script setup lang="ts">
// A newer orrery is out (ORR-608): a small notice at the sidebar's foot, above the version, with its release notes and
// how to update. × hides it for that version, in this browser; the next one shows again. The server asks GitHub
// (`GET /api/version`), unless ORRERY_UPDATE_CHECK=false turned that off, and then there's never one.
interface Newer { version: string, url: string }

const HIDDEN = 'orrery-update-hidden'
const newer = ref<Newer | null>(null)
const hidden = ref<string | null>(null)

onMounted(async () => {
    hidden.value = localStorage.getItem(HIDDEN)
    newer.value = (await apiFetch<{newer: Newer | null}>('/version').catch(() => null))?.newer ?? null
})

function hide() {
    if (!newer.value) return
    localStorage.setItem(HIDDEN, newer.value.version)
    hidden.value = newer.value.version
}
</script>

<template>
  <div
      v-if="newer && hidden !== newer.version"
      role="status"
      class="mt-1.5 flex items-start gap-2 rounded-lg border border-accent-500/40 bg-accent-500/10 px-2.5 py-2 text-[12px] leading-snug text-fg"
  >
    <svg class="mt-0.5 size-3.5 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="font-medium">orrery {{ newer.version }} is out</span>
      <span class="flex gap-3 text-muted">
        <a :href="newer.url" target="_blank" rel="noopener" class="whitespace-nowrap hover:text-fg hover:underline" title="This release's notes on GitHub">What's new ↗</a>
        <a href="https://github.com/steffendybvik/orrery/blob/main/docs/running.md#updating" target="_blank" rel="noopener" class="whitespace-nowrap hover:text-fg hover:underline" title="How to update orrery">Updating ↗</a>
      </span>
    </div>
    <button type="button" class="-mr-1 rounded px-1 text-faint hover:text-fg" title="Hide until the next version" :aria-label="`Hide the notice for ${newer.version}`" @click="hide">×</button>
  </div>
</template>
