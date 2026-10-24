<script setup lang="ts">
// A labelled Orrery (a second one, e.g. Work) says so at the start of every tab's title.
const {label} = useRuntimeConfig().public
if (label) useHead({titleTemplate: title => `${label} · ${title ?? 'Orrery'}`})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
