<script setup lang="ts">
// Said once (ORR-448): in Docker, backups in the default folder stay on this computer, so a lost disk loses them too.
// Shown until it's dismissed in this browser, and only to the owner once they've named themselves; App settings →
// Database says it as long as it's so, so it isn't shown over that page.
const route = useRoute()
const {settings} = useAppSettings()
const {named} = useOwner()
const KEY = 'orrery-backup-hint-seen'
const seen = ref(true)
onMounted(() => {
    seen.value = localStorage.getItem(KEY) === '1'
})
function dismiss() {
    seen.value = true
    localStorage.setItem(KEY, '1')
}
</script>

<template>
  <div
      v-if="named && !seen && settings.database?.backup_local && route.path !== '/settings'"
      role="status"
      class="fixed right-4 bottom-20 z-30 flex w-80 flex-col gap-2 rounded-xl bg-panel p-3 text-xs shadow-lg ring-1 ring-amber-500/40"
      data-backup-hint
  >
    <p class="text-[13px] font-medium text-fg">Backups are only on this computer</p>
    <p class="text-muted">
      They're in the default folder, on the same disk as the data. Set <code>ORRERY_BACKUP</code> to a folder that leaves
      it (iCloud Drive, Dropbox, one Time Machine covers), then <code>docker compose up -d</code>.
    </p>
    <div class="flex items-center gap-2">
      <NuxtLink to="/settings#database" class="text-accent-600 hover:underline dark:text-accent-400" @click="dismiss">Database settings</NuxtLink>
      <UiButton size="xs" class="ml-auto" @click="dismiss">Got it</UiButton>
    </div>
  </div>
</template>
