// `GET /api/chats/:chat` → the chat, with its messages; 404 once it has ended.
export default defineEventHandler(event => chatOf(param(event, 'chat')))
