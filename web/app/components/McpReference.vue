<script setup lang="ts">
import type {McpReference, McpTool} from '#shared/mcp'

// The MCP server tab on Connect (ORR-772): what connecting gives a session. An agent gets its tools over MCP, so this is
// for the owner. It's read from the channel's own lists, so it says what a session is really given.
const reference = ref<McpReference>()
const failed = ref('')
onMounted(() => apiFetch<McpReference>('/mcp').then(got => reference.value = got).catch(error => failed.value = errorMessage(error, 'read')))

const workCell = (tool: McpTool) => tool.work === true ? 'Yes' : tool.work ? `On request` : '–'
const workTitle = (tool: McpTool) => typeof tool.work === 'string' ? `It asks for these with more_tools (${tool.work})` : undefined
</script>

<template>
  <div class="flex flex-col gap-8">
    <header class="flex flex-col gap-2">
      <h2 class="text-2xl font-semibold tracking-tight">What connecting gives a session</h2>
      <p class="text-[15px] leading-relaxed text-muted">
        A session reaches orrery through its channel, an MCP server in the repo's <code class="font-mono text-[13px]">.mcp.json</code>. These are its tools, and who gets each.
        Read from the channel itself, so this stays what a session is given.
      </p>
    </header>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400" role="alert">{{ failed }}</p>
    <template v-if="reference">
      <section class="flex flex-col gap-5" aria-label="Tools">
        <div v-for="group in reference.groups" :key="group.title" class="flex flex-col gap-2">
          <h3 class="label">{{ group.title }}</h3>
          <div class="overflow-x-auto rounded-xl border border-line">
            <table class="w-full min-w-[36rem] text-left text-[13px]">
              <thead class="text-xs text-faint">
                <tr class="border-b border-line">
                  <th scope="col" class="px-3 py-2 font-medium">Tool</th>
                  <th scope="col" class="w-24 px-2 py-2 font-medium">Session</th>
                  <th scope="col" class="w-14 px-2 py-2 font-medium">Chat</th>
                  <th scope="col" class="w-20 px-2 py-2 font-medium">Untrusted</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="tool in group.tools" :key="tool.name" class="border-b border-line/60 align-top last:border-b-0" :data-tool="tool.name">
                  <td class="px-3 py-2">
                    <code class="font-mono text-xs text-fg">{{ tool.name }}</code>
                    <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ tool.description }}</p>
                  </td>
                  <td class="px-2 py-2 text-xs text-muted" :title="workTitle(tool)">{{ workCell(tool) }}</td>
                  <td class="px-2 py-2 text-xs text-muted">{{ tool.chat ? 'Yes' : '–' }}</td>
                  <td class="px-2 py-2 text-xs text-muted">{{ tool.untrusted ? 'Yes' : '–' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
      <section class="flex flex-col gap-2" aria-label="What asks you first">
        <h3 class="text-[15px] font-semibold">What asks you first</h3>
        <p class="text-[13px] leading-relaxed text-muted">The chat asks for these through <code class="font-mono text-xs">request</code>, and nothing happens until you press Allow in it. A work session asks for a schedule on its issue instead.</p>
        <ul class="flex flex-col divide-y divide-line/60 rounded-xl border border-line">
          <li v-for="request in reference.requests" :key="request.name" class="px-3 py-2">
            <code class="font-mono text-xs text-fg">{{ request.name }}</code>
            <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ request.description }}</p>
          </li>
        </ul>
      </section>
      <section class="flex flex-col gap-2" aria-label="Environment">
        <h3 class="text-[15px] font-semibold">Environment</h3>
        <p class="text-[13px] leading-relaxed text-muted">What the channel reads, set in the repo's <code class="font-mono text-xs">.mcp.json</code> or a session's environment.</p>
        <ul class="flex flex-col divide-y divide-line/60 rounded-xl border border-line">
          <li v-for="variable in reference.env" :key="variable.name" class="px-3 py-2">
            <code class="font-mono text-xs text-fg">{{ variable.name }}</code>
            <p class="mt-0.5 text-xs leading-relaxed text-muted">{{ variable.description }}</p>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
