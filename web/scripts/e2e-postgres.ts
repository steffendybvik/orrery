// `jiti scripts/e2e-postgres.ts`: empties the Postgres the e2e run uses (E2E_POSTGRES_URL), as removing
// the SQLite file does, so the flows start from a new orrery. It drops every table in `public`, so it only
// touches a database whose name says it's for the tests (`orrery_e2e`), never a real one by mistake.
import pg from 'pg'

const url = process.env.E2E_POSTGRES_URL
if (!url) throw new Error('E2E_POSTGRES_URL is not set')
const name = new URL(url).pathname.slice(1)
if (!/e2e/.test(name)) throw new Error(`Not emptying "${name}": the e2e database's name has to say e2e (orrery_e2e)`)

const client = new pg.Client({connectionString: url})
await client.connect()
await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
await client.end()
