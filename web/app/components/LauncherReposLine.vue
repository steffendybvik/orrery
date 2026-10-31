<script setup lang="ts">
// On Sessions → Setup, one line for the repos the launchers serve, pointing at their list on Connect (ORR-774).
const {repos} = useLauncherRepos()
</script>

<template>
  <p v-if="repos.length" class="text-xs text-muted">
    <NuxtLink to="/connect#connected-repos" class="text-accent-700 underline underline-offset-2 dark:text-accent-400">Serving {{ repos.length }} {{ repos.length === 1 ? 'repo' : 'repos' }}</NuxtLink>
  </p>
</template>
