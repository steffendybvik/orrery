// `GET /api/chats/:chat` → the chat, with its messages: running, or ended since orrery started (ORR-870); 404 after a restart.
export default defineEventHandler(event => readChat(param(event, 'chat')))
