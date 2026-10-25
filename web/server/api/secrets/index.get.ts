// `GET /api/secrets` → every secret by name, with its last 4 characters, hosts, projects and last use;
// never a value.
export default defineEventHandler(async () => useSecrets().list())
