<script setup lang="ts">
import type {NuxtError} from '#app'

// An unknown URL, or a page that failed to load, inside the app (sidebar and all) rather than Nuxt's own
// page. Going anywhere from here clears the error, so the sidebar's links work as they do on any page.
const props = defineProps<{error: NuxtError}>()
const route = useRoute()
watch(() => route.fullPath, () => clearError())
const missing = computed(() => props.error.statusCode === 404)
useHead(() => ({title: missing.value ? 'Not found · Orrery' : 'Something went wrong · Orrery'}))
</script>

<template>
  <NuxtLayout>
    <PageHeader>
      <h1 class="truncate text-sm font-medium">{{ missing ? 'Not found' : 'Something went wrong' }}</h1>
    </PageHeader>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <NotFound v-if="missing" reason="The link may be old, or mistyped." to="/now" back="Go to Now">
        Nothing at <span class="font-mono">{{ route.path }}</span>
      </NotFound>
      <div v-else class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
        <div class="flex max-w-md flex-col items-center gap-2">
          <h2 class="text-[15px] font-medium text-fg">This page didn't load.</h2>
          <p class="text-xs text-faint">{{ error.statusMessage || error.message }}</p>
          <UiButton class="mt-2" @click="clearError({redirect: route.fullPath})">Try again</UiButton>
        </div>
      </div>
    </div>
  </NuxtLayout>
</template>
