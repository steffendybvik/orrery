// The channel's server name in a repo's .mcp.json, as the Connect page writes it: `orrery-<environment>`, the
// environment made an id (`Work` → `orrery-work`, `my laptop` → `orrery-my-laptop`), as web/shared's `slugify` does.
export function serverName(environment) {
    const slug = String(environment ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
    return `orrery-${slug || 'orrery'}`
}
