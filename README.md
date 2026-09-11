# Payment Service

A Node.js Express microservice that simulates payment processing. Clients create a payment, look it up by ID, and update its status. Create returns immediately as `pending`; a background worker then moves the payment through `processing` to `completed` or `failed`. Payments are stored in JSON files. This does not move real money.

## Setup

Requires Node.js 18 or later.

### Docker (recommended)

Starts the API, worker, and RabbitMQ together.

```bash
docker compose up --build
```

- API: `http://localhost:3000`
- RabbitMQ management UI: `http://localhost:15672` (`guest` / `guest`)

### Local (without Docker)

Install dependencies, start RabbitMQ on `localhost:5672`, then run the API and worker in separate terminals:

```bash
npm install
cp .env.example .env
npm run dev
```

```bash
npm run dev:worker
```

Production-style:

```bash
npm run build
npm start
npm run worker
```

Copy `.env.example` to `.env` to change the port, log level, simulated processing delay, or RabbitMQ URL. Invalid environment values fail on startup.

## API

Base URL: `http://localhost:3000`

Every response includes `X-Request-ID`. Send that header to correlate client and server logs; if omitted, the server generates a UUID v4.

Success:

```json
{ "success": true, "data": {} }
```

Error:

```json
{ "success": false, "error": { "code": "STRING_CODE", "message": "Human readable message" } }
```

Payment IDs are UUID v4. Other UUID versions return `400 VALIDATION_ERROR`.

### POST /payments

Create a payment. The record is saved as `pending` and returned immediately. A worker simulates processing in the background.

| Header | Required | Description |
| --- | --- | --- |
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | No | Same key and body replay the original payment (`200`). Same key and different body returns `409 IDEMPOTENCY_CONFLICT`. |
| `X-Request-ID` | No | Correlation ID stored on the payment |

| Field | Type | Rules |
| --- | --- | --- |
| `amount` | number | Greater than zero |
| `currency` | string | 3 uppercase letters, e.g. `USD` |
| `customerId` | string | Non-empty |

```bash
curl -s -X POST http://localhost:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"amount":49.99,"currency":"USD","customerId":"cus_123"}'
```

`201` for a new payment, `200` for an idempotent replay.

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 49.99,
    "currency": "USD",
    "customerId": "cus_123",
    "status": "pending",
    "requestId": "3b5e2c1a-7c4f-4d2a-9e8b-1a2b3c4d5e6f",
    "createdAt": "2026-09-11T12:00:00.000Z",
    "updatedAt": "2026-09-11T12:00:00.000Z"
  }
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid or missing fields |
| 409 | `IDEMPOTENCY_CONFLICT` | Same idempotency key, different payload |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

### GET /payments/:paymentId

Return a payment by ID.

```bash
curl -s http://localhost:3000/payments/550e8400-e29b-41d4-a716-446655440000
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `paymentId` is not a UUID v4 |
| 404 | `PAYMENT_NOT_FOUND` | No payment with that ID |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

### PATCH /payments/:paymentId/status

Apply a status transition. `completed` and `failed` are terminal.

| From | To |
| --- | --- |
| `pending` | `processing` |
| `processing` | `completed` |
| `processing` | `failed` |

```bash
curl -s -X PATCH http://localhost:3000/payments/550e8400-e29b-41d4-a716-446655440000/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"processing"}'
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid UUID v4 or status |
| 404 | `PAYMENT_NOT_FOUND` | No payment with that ID |
| 409 | `INVALID_STATE_TRANSITION` | Transition is not allowed |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

Unknown routes return `404 NOT_FOUND`.

## Testing

```bash
npm test
```

Coverage:

```bash
npm test:coverage
```

Tests use Jest and Supertest. HTTP and worker tests run against an in-memory event bus, so RabbitMQ is not required. If a broker is reachable at `RABBITMQ_URL`, messaging tests also run against it. If it is not, those suites are skipped rather than reported as passed.
