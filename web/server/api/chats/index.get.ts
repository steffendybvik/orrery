// `GET /api/chats` → the chats running now, newest first, each with its messages.
export default defineEventHandler(() => listChats())
