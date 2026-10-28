<script setup lang="ts">
// Every tab's title starts with which orrery this is (personal, work, …).
const {environment} = useRuntimeConfig().public
if (environment) useHead({titleTemplate: title => `${environment} · ${title ?? 'orrery'}`})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
