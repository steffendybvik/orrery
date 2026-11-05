// `GET /api/chats/:chat` → the chat, with its messages: running, or ended (ORR-870), kept across restarts (ORR-877).
export default defineEventHandler(event => readChat(param(event, 'chat')))
