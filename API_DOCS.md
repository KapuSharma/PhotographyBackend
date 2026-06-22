# Photographer AI Kit — Backend API Documentation

**Base URL:** `http://localhost:5000/api`  
**All requests/responses:** `application/json`

---

## Authentication

All routes except `POST /auth/login` and `GET /health` require a JWT Bearer token.

**Header format:**
```
Authorization: Bearer <token>
```

The token is issued on login and expires in **7 days**. The decoded payload contains:
```json
{ "userId": "...", "clientId": "...", "email": "...", "role": "..." }
```

The middleware sets `req.user` from the token. All data operations automatically scope to `req.user.clientId` — **do not pass `clientId` in request bodies or query params for protected routes.**

**Auth errors:**
| Code | Message |
|------|---------|
| `401` | `Unauthorised — no token` |
| `401` | `Unauthorised — invalid token` |

---

## Health

### `GET /health`
Check server and database connectivity. No auth required.

**Response `200`**
```json
{ "status": "ok", "db": "connected" }
```
**Response `500`**
```json
{ "status": "error", "message": "..." }
```

---

## Auth

### `POST /auth/login`
Authenticate a user. No auth required.

**Body**
```json
{
  "email": "photographer@studio.com",
  "password": "plaintext_password"
}
```

**Response `200`**
```json
{
  "token": "<jwt>",
  "user": {
    "id": "cuid",
    "name": "Marcus Roux",
    "email": "photographer@studio.com",
    "role": "photographer",
    "clientId": "cuid"
  }
}
```

| Code | Meaning |
|------|---------|
| `400` | Email and password are required |
| `401` | Invalid email or password |

> Also sets `lastLogin` timestamp on the user record.

---

### `GET /auth/me`
Return the currently authenticated user. Requires Bearer token.

**Response `200`**
```json
{
  "id": "cuid",
  "name": "Marcus Roux",
  "email": "photographer@studio.com",
  "role": "photographer",
  "clientId": "cuid"
}
```

| Code | Meaning |
|------|---------|
| `401` | No token / invalid token |
| `404` | User not found |

---

## Clients

> Intended for HOI super-admin use. All routes require auth.

### `GET /clients`
Get all clients.

**Response `200`** — array of client objects
```json
[
  {
    "id": "cuid",
    "name": "Marcus Roux",
    "studioName": "ROUX STUDIO",
    "email": "marcus@rouxstudio.com",
    "phone": "+61400000000",
    "domain": "rouxstudio.com",
    "logoUrl": "https://...",
    "accentColor": "#00e5c8",
    "plan": "starter",
    "status": "active",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

---

### `GET /clients/:id`
Get a single client.

**Response `200`** — client object  
**Response `404`** — `{ "message": "Client not found" }`

---

### `POST /clients`
Create a new client.

**Body**
```json
{
  "name": "Marcus Roux",
  "studioName": "ROUX STUDIO",
  "email": "marcus@rouxstudio.com",
  "phone": "+61400000000",
  "domain": "rouxstudio.com",
  "logoUrl": "https://...",
  "accentColor": "#00e5c8",
  "plan": "starter"
}
```

**Response `201`** — created client object

---

### `PATCH /clients/:id`
Update a client. Send only fields to change.

**Response `200`** — updated client object

---

### `DELETE /clients/:id`
Delete a client.

**Response `200`** — `{ "message": "Client deleted" }`

---

## Leads

### `GET /leads`
Get all leads for the authenticated client. Scoped automatically by `clientId`.

**Query Params**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status: `New` `Contacted` `Quoted` `Booked` `Lost` |
| `source` | string | Filter by source: `AI Chatbot` `Website Form` `Referral` etc. |

**Response `200`** — array of leads, newest first. Each lead includes two extra fields:
- `transcript` — messages array from the linked AI conversation (empty array if none)
- `time` — alias for `createdAt`

---

### `GET /leads/:id`
Get a single lead with its AI conversation.

**Response `200`**
```json
{
  "id": "cuid",
  "clientId": "cuid",
  "name": "Lena Park",
  "company": "Atlassian APAC",
  "email": "lena@atlassian.com",
  "phone": "+61411000000",
  "eventType": "Product Campaign",
  "eventDate": "2026-08-01",
  "location": "Sydney",
  "budget": "$9,000–12,000",
  "message": "We need a Q3 product launch shoot.",
  "status": "New",
  "source": "AI Chatbot",
  "score": 94,
  "notes": null,
  "activity": [],
  "createdAt": "2026-04-01T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:00:00.000Z",
  "transcript": [],
  "time": "2026-04-01T00:00:00.000Z"
}
```

**Response `404`** — `{ "message": "Lead not found" }`

---

### `POST /leads`
Create a new lead. `clientId` is set automatically from the auth token.

> **Score is calculated automatically** — do not pass a `score` field.

**Body**
```json
{
  "name": "Lena Park",
  "company": "Atlassian APAC",
  "email": "lena@atlassian.com",
  "phone": "+61411000000",
  "eventType": "Product Campaign",
  "eventDate": "2026-08-01",
  "location": "Sydney",
  "budget": "$9,000–12,000",
  "message": "We need a Q3 product launch shoot.",
  "source": "AI Chatbot"
}
```

**Response `201`** — created lead object (includes calculated `score`)

**Score calculation logic:**

| Signal | Points |
|--------|--------|
| Base | 50 |
| Budget ≥ $8,000 | +20 |
| Budget $5k–$8k | +15 |
| Budget $2k–$5k | +10 |
| Budget < $2k | +5 |
| Budget mentioned (unparseable) | +3 |
| Source = Referral | +15 |
| Source = AI Hunter | +12 |
| Source = AI Chatbot | +10 |
| Source = Website Form | +7 |
| Source = Google / other | +3 |
| Urgency keyword in message/notes | +8 |
| Has phone | +3 |
| Has eventType | +3 |
| Has eventDate | +4 |
| Has location | +2 |
| Has company | +3 |
| Message longer than 20 chars | +3 |
| **Max** | **100** |

Urgency keywords: `urgent`, `asap`, `immediately`, `deadline`, `launch`, `next week`, `next month`, `confirmed`, `ready to proceed`, `approved`

---

### `PATCH /leads/:id`
Update a lead. Send only fields to change.

**Body**
```json
{
  "status": "Contacted",
  "notes": "Called on 1 April, very interested",
  "activity": {
    "id": 1712000000000,
    "type": "contacted",
    "label": "Marked Contacted",
    "date": "2026-04-01T10:00:00.000Z",
    "method": "Email",
    "discussion": "Discussed brand campaign details",
    "followup": "2026-04-04T00:00:00.000Z"
  }
}
```

**`activity` field behaviour:** If provided, the activity object is **appended** to the existing array — it does not replace it.

**Score recalculation:** If any of these fields are present in the body, the score is automatically recalculated against the merged (existing + updated) lead data: `budget` `source` `message` `notes` `phone` `eventType` `eventDate` `location` `company`

**Auto-payment creation:** When `status` is set to `"Booked"`, a Draft payment is automatically created if one does not already exist for this lead:
```json
{
  "company": "<lead.company or lead.name>",
  "amount": 0,
  "type": "Deposit",
  "status": "Draft",
  "method": "Awaiting"
}
```

**Response `200`** — updated lead object

---

### `DELETE /leads/:id`
Delete a lead.

**Response `200`** — `{ "message": "Lead deleted" }`

---

## Payments

### `GET /payments`
Get all payments for the authenticated client.

**Response `200`** — array of payment objects, newest first
```json
[
  {
    "id": "cuid",
    "clientId": "cuid",
    "leadId": "cuid",
    "company": "Atlassian APAC",
    "amount": 4500,
    "type": "Deposit 50%",
    "status": "Pending",
    "paymentDate": "2026-04-15",
    "method": "Bank Transfer",
    "paymentId": "REF-001",
    "notes": null,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:00.000Z"
  }
]
```

---

### `GET /payments/:id`
Get a single payment. Ownership is verified — returns `404` if the payment belongs to another client.

**Response `200`** — payment object  
**Response `404`** — `{ "message": "Payment not found" }`

---

### `POST /payments`
Create a payment manually. `clientId` is set automatically from the auth token.

**Body**
```json
{
  "company": "Frank Body",
  "amount": 2200,
  "type": "Retainer",
  "status": "Pending",
  "paymentDate": "2026-05-01",
  "method": "Stripe",
  "leadId": "cuid",
  "paymentId": "INV-042",
  "notes": "Monthly content retainer"
}
```

| Field | Required | Default |
|-------|----------|---------|
| `company` | Yes | — |
| `amount` | No | `0` |
| `type` | Yes | — |
| `status` | No | `"Draft"` |
| `method` | No | `"Awaiting"` |
| `leadId` | No | `null` |
| `paymentDate` | No | `null` |
| `paymentId` | No | `null` |
| `notes` | No | `null` |

**Type options:** `Deposit 50%` · `Full Payment` · `Retainer` · `Invoice` · `Balance Due`  
**Status options:** `Draft` · `Pending` · `Paid` · `Overdue`  
**Method options:** `Bank Transfer` · `Cash` · `Card` · `Stripe` · `PayPal` · `Awaiting`

**Response `201`** — created payment object

---

### `PATCH /payments/:id`
Update a payment. Ownership is verified before update.

**Body** _(any subset of payment fields)_
```json
{
  "amount": 4500,
  "status": "Paid",
  "paymentDate": "2026-04-10",
  "method": "Bank Transfer",
  "paymentId": "TXN-8821"
}
```

**Response `200`** — updated payment object  
**Response `404`** — `{ "message": "Payment not found" }` (also returned if owned by another client)

---

### `DELETE /payments/:id`
Delete a payment. Ownership is verified before deletion.

**Response `200`** — `{ "message": "Payment deleted" }`  
**Response `404`** — `{ "message": "Payment not found" }`

---

## Users

### `GET /users`
Get all users for the authenticated client. `passwordHash` is never returned.

**Response `200`** — array of user objects
```json
[
  {
    "id": "cuid",
    "clientId": "cuid",
    "name": "Marcus Roux",
    "email": "marcus@rouxstudio.com",
    "role": "photographer",
    "lastLogin": "2026-04-01T00:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

---

### `GET /users/:id`
Get a single user. `passwordHash` excluded.

**Response `200`** — user object  
**Response `404`** — `{ "message": "User not found" }`

---

### `POST /users`
Create a user. `clientId` is taken from the auth token.

**Body**
```json
{
  "name": "Marcus Roux",
  "email": "marcus@rouxstudio.com",
  "passwordHash": "<bcrypt_hash>",
  "role": "photographer"
}
```

> Hash the password with bcrypt before sending. Never send a plaintext password to this endpoint.

**Response `201`** — created user object (`passwordHash` excluded)

---

### `PATCH /users/:id`
Update a user.

**Response `200`** — updated user object

---

### `DELETE /users/:id`
Delete a user.

**Response `200`** — `{ "message": "User deleted" }`

---

## Services

### `GET /services`
Get all services for the authenticated client.

**Response `200`** — array of service objects

---

### `GET /services/:id`
Get a single service.

**Response `200`** — service object  
**Response `404`** — `{ "message": "Service not found" }`

---

### `POST /services`
Create a service. `clientId` is set from the auth token.

**Body**
```json
{
  "name": "Brand Campaign",
  "description": "Full day shoot with post-production",
  "startingPrice": 8400.00,
  "category": "Commercial",
  "active": true
}
```

**Response `201`** — created service object

---

### `PATCH /services/:id`
Update a service.

**Response `200`** — updated service object

---

### `DELETE /services/:id`
Delete a service.

**Response `200`** — `{ "message": "Service deleted" }`

---

## FAQs

### `GET /faqs`
Get all FAQs for the authenticated client.

**Response `200`** — array of FAQ objects

---

### `GET /faqs/:id`
Get a single FAQ.

**Response `200`** — FAQ object  
**Response `404`** — `{ "message": "FAQ not found" }`

---

### `POST /faqs`
Create a FAQ. `clientId` is set from the auth token.

**Body**
```json
{
  "question": "Do you shoot destination weddings?",
  "answer": "Yes, we travel worldwide. Travel fees may apply.",
  "active": true
}
```

**Response `201`** — created FAQ object

---

### `PATCH /faqs/:id`
Update a FAQ.

**Response `200`** — updated FAQ object

---

### `DELETE /faqs/:id`
Delete a FAQ.

**Response `200`** — `{ "message": "FAQ deleted" }`

---

## AI Config

One config record per client. All operations are scoped to the authenticated client — no `clientId` in the URL or body.

### `GET /ai-config`
Get AI config for the authenticated client. Returns defaults if no config exists yet.

**Response `200`**
```json
{
  "id": "cuid",
  "clientId": "cuid",
  "aiAssistantName": "Aria",
  "systemPrompt": "You are a helpful assistant for ROUX STUDIO...",
  "tone": "professional",
  "greetingMessage": "Hi! I'm Aria. How can I help?",
  "bookingCtaText": "Book a Session",
  "primaryNiche": "commercial",
  "smsNotifications": true,
  "humanDelay": false
}
```

If no config exists, returns these defaults:
```json
{
  "aiAssistantName": "",
  "primaryNiche": "commercial",
  "tone": "professional",
  "smsNotifications": true,
  "humanDelay": false,
  "greetingMessage": "",
  "bookingCtaText": "Book a Session"
}
```

---

### `PUT /ai-config`
Create or update AI config for the authenticated client (upsert). Send only fields to change.

**Body**
```json
{
  "aiAssistantName": "Aria",
  "tone": "friendly",
  "greetingMessage": "Hi! I'm Aria, how can I help?",
  "bookingCtaText": "Request a Quote",
  "primaryNiche": "wedding",
  "smsNotifications": false,
  "humanDelay": true
}
```

| Field | Type | Default |
|-------|------|---------|
| `aiAssistantName` | string | `""` |
| `systemPrompt` | string | `null` |
| `tone` | string | `"professional"` |
| `greetingMessage` | string | `null` |
| `bookingCtaText` | string | `"Book a Session"` |
| `primaryNiche` | string | `"commercial"` |
| `smsNotifications` | boolean | `true` |
| `humanDelay` | boolean | `false` |

**Response `200`** — upserted config object

---

## Conversations

### `GET /conversations`
Get all AI conversations for the authenticated client, newest first.

**Response `200`** — array of conversation objects

---

### `GET /conversations/:id`
Get a single conversation with full message history.

**Response `200`**
```json
{
  "id": "cuid",
  "clientId": "cuid",
  "leadId": "cuid",
  "messages": [
    { "role": "user",      "content": "Do you shoot weddings?" },
    { "role": "assistant", "content": "Yes! We offer full wedding coverage." }
  ],
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

**Response `404`** — `{ "message": "Conversation not found" }`

---

### `POST /conversations`
Create a new conversation. `clientId` is set from the auth token.

**Body**
```json
{
  "leadId": "cuid",
  "messages": [
    { "role": "user", "content": "Do you shoot weddings?" }
  ]
}
```

**Response `201`** — created conversation object

---

### `PATCH /conversations/:id`
Replace the messages array on a conversation.

**Body**
```json
{
  "messages": [
    { "role": "user",      "content": "Do you shoot weddings?" },
    { "role": "assistant", "content": "Yes! We offer full wedding coverage." }
  ]
}
```

**Response `200`** — updated conversation object

---

## Reference

### Lead Status

| Status | Description |
|--------|-------------|
| `New` | Just captured, not yet actioned |
| `Contacted` | Photographer has reached out |
| `Quoted` | Quote has been sent |
| `Booked` | Confirmed booking — auto-creates a Draft payment |
| `Lost` | Lead did not convert |

### Payment Status

| Status | Description |
|--------|-------------|
| `Draft` | Created but not yet sent |
| `Pending` | Sent, awaiting payment |
| `Paid` | Payment received |
| `Overdue` | Past due date, not paid |

### Payment Types

`Deposit 50%` · `Full Payment` · `Retainer` · `Invoice` · `Balance Due`

### Payment Methods

`Bank Transfer` · `Cash` · `Card` · `Stripe` · `PayPal` · `Awaiting`

---

## Error Response Format

All errors return:
```json
{ "message": "Description of the error" }
```

| Code | Meaning |
|------|---------|
| `400` | Bad request / validation error |
| `401` | Unauthorised — missing or invalid token |
| `404` | Resource not found (or not owned by this client) |
| `500` | Server / database error |
