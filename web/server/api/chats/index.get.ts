// `GET /api/chats` → the chats running now and those that have ended, newest first, each with its messages.
export default defineEventHandler(() => listChats())
