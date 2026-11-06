# Stream Companion replies

## What will change

- Add an authenticated Companion streaming endpoint that sends Gemini's response to the browser as it is generated.
- Preserve the existing prompt, diary/blog date filters, conversation memory, and Gemini fallback order.
- Update the chat screen to create an in-progress Companion message and append text live, then save the finished response to conversation history.
- Surface a clear error if streaming fails, without saving an empty or partial assistant reply.

## Technical details

- Use Gemini's streaming REST response from server-side code so the private API key never reaches the browser.
- Authenticate each stream request with the user's existing session token.
- Parse Gemini SSE chunks incrementally and forward plain UTF-8 text through a `ReadableStream`.
- Verify the build and run an authenticated end-to-end chat check if a test session is available.
