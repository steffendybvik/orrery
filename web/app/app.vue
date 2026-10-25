<script setup lang="ts">
// Every tab's title starts with which Orrery this is (personal, work, …).
const {environment} = useRuntimeConfig().public
if (environment) useHead({titleTemplate: title => `${environment} · ${title ?? 'Orrery'}`})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
