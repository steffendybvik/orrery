# Orrery

## Roadmap

The roadmap is in Orrery (http://localhost:9010), project `orrery`, issue ids `ORR-n`. How to use it: `curl -s http://localhost:9010/llms-full.txt`.

- Work from an issue: set it to `doing` (assignee `claude`) before starting, comment as it moves, `done` when it ships.
- Knowledge (decisions, how things work) goes in the project's docs.
- Send `Orrery-Actor: claude` on every write. Orrery hands out ids; don't send one.
