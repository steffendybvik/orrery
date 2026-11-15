<script setup lang="ts">
import {channelServer} from '#shared/connect'

// For an agent with no launcher adapter yet (ORR-1075): orrery can't start its sessions or send them work, but the
// agent can keep the roadmap through the REST API, or orrery's tools as an MCP server over stdio.
const origin = serverOrigin()
const server = channelServer(origin)
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl bg-panel p-4 text-[13px] leading-relaxed text-muted ring-1 ring-line" data-other-agent>
    <span class="font-medium text-fg">Another agent</span>
    <span>
      orrery only starts and sends work to Claude Code sessions so far, so the launcher and the Claude setup aren't for it.
      Your agent can still keep its roadmap here: point it at
      <a :href="`${origin}/llms-full.txt`" target="_blank" class="font-mono text-accent-700 underline underline-offset-2 dark:text-accent-400">/llms-full.txt</a>,
      which says how to use the REST API, or give it orrery's tools as an MCP server.
    </span>
    <CopyBlock title="Once on this machine" hint="Puts orrery's bootstrap in place, which runs the channel as this orrery serves it. Needs Node." :text="server.bootstrap" />
    <CopyBlock title="The MCP server, over stdio" hint="Its command and environment, for your agent's MCP config." :text="server.command" />
  </div>
</template>
