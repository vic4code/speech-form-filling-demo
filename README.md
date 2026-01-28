# Speech Form Filling Demo

## Overview
This project is a front-end web application paired with a back-end service that enables users to complete a form using voice input. The UI follows the provided reference page styling (clean, light background, card-based sections, green accent), supports RWD, and intentionally omits any watermark. The back-end service will call the OpenAI API directly; a separate reference repository will be provided later for alignment.

The application provides **two voice-driven modes** via tabs:
1. **Real-time STT Form Mode**: streaming speech-to-text (STT) to fill form fields in sequence with block-level focus.
2. **Conversation Mode**: a WebSocket Realtime voice agent that **only listens** (no spoken output) while the user chats via text. The conversation produces a structured output that matches a defined schema and is submitted as a form request.

After submission, users are redirected to a **Request Log page** that lists each submitted request with token usage and cost, and supports detail view for verifying what was submitted.

## Goals
- Provide a **voice-first form-filling experience** with full keyboard/mouse fallback.
- Preserve a **clear review & submit step** before final submission.
- Show **traceable request logs** with input/output token counts and cost per request.
- Support **RWD** across desktop, tablet, and mobile.

## Information Architecture
### Page 1: Voice Form Filling
- Header/title area
- Two tabs: **Real-time STT** and **Conversation**
- Form sections aligned to the reference design
- Submit actions and status indicators

### Page 2: Request Logs
- List of submitted requests
- Each item shows:
  - Request ID / timestamp
  - Mode (STT vs Conversation)
  - Input tokens, output tokens
  - Estimated cost
  - Status (success/failure)
- Detail view (modal or new page) showing:
  - Structured payload submitted
  - Any backend response
  - Field-by-field values

## Functional Requirements
### Real-time STT Form Mode
- Live transcription populates the **active field**.
- Field navigation is **block-based**; the app moves to the next field when:
  - User says a “next” intent, or
  - The UI action is triggered (button or voice command).
- The final step includes a **review confirmation** step before submission.
- Users can complete the process **fully by voice** (start/stop, next/previous, submit).

### Conversation Mode
- WebSocket Realtime voice agent **listens only** (no speech output).
- User interacts through **text-based chat UI**.
- The conversation generates a **structured output** following a pre-defined schema.
- Submit sends this structured payload to backend via POST.

### Request Logs
- Each submission is saved as a **request** (not a session).
- Logs include per-request:
  - Input token count
  - Output token count
  - Total token count
  - Estimated cost (based on configurable pricing)
- Users can click to view request details.

## Data & API Contracts (Proposed)
### Endpoints
- `POST /api/requests`
  - Body: `{ mode, payload, meta }`
  - `mode`: `"stt" | "conversation"`
  - `payload`: structured form data
  - `meta`: `{ inputTokens, outputTokens, totalTokens, cost, timestamps }`

- `GET /api/requests`
  - List all submitted requests

- `GET /api/requests/:id`
  - Get a single request detail

### Structured Output Schema (Draft)
```json
{
  "requestId": "string",
  "mode": "stt | conversation",
  "formData": {
    "tripType": "string",
    "tripDates": {
      "start": "YYYY-MM-DD",
      "end": "YYYY-MM-DD"
    },
    "participants": [
      {
        "name": "string",
        "department": "string",
        "employeeId": "string"
      }
    ],
    "budget": "number",
    "notes": "string"
  },
  "tokenUsage": {
    "input": 0,
    "output": 0,
    "total": 0
  },
  "cost": 0,
  "createdAt": "ISO-8601"
}
```

## UI/UX Notes
- Keep styling consistent with the reference page (card sections, subtle borders, green accents).
- Provide clear states for recording: idle, listening, processing, paused.
- Avoid overwhelming the user—progress indicators per section.
- Display errors near the relevant field and in a global toast/alert area.

## Accessibility & RWD
- All controls reachable via keyboard and screen readers.
- Mobile: stack sections and simplify layout.
- Tablet: two-column layout where possible.
- Desktop: full layout matching reference.

## Open Questions / Confirmation Needed
1. **Backend token/cost calculation**: Should the backend return tokens and cost, or should the front-end estimate them based on pricing config?
2. **Conversation mode schema**: Is the draft schema acceptable, or do you have a specific schema you want to use?
3. **Voice commands list**: Do you want a fixed command set (e.g., “next field”, “previous field”, “submit”), or should it be configurable?
4. **Detail view**: Should the request detail be a modal, or a dedicated page route?
5. **Authentication**: Is login required, or is this a public demo without auth?

## Non-Goals
- No post-submit editing (submissions are final).
- No audio playback from the conversation agent.

## Development Notes
- All implementation comments and developer notes should be written in English.
- Follow RWD best practices and keep markup semantic.

## Local Development (UV)
1. Install dependencies:
   ```bash
   uv sync
   ```
2. Start the server:
   ```bash
   uv run uvicorn app.main:app --reload --port 8000
   ```
3. Open the app:
   - Form page: http://localhost:8000/index.html
   - Request logs: http://localhost:8000/logs.html
