// `GET /api/chats` → the chats running now and those ended since orrery started, newest first, each with its messages.
export default defineEventHandler(() => listChats())
