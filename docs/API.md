# Payment Service API

Base URL (local): `http://localhost:3000`

This API is a **payment simulation**. It does not process real funds. HTTP writes JSON (including a transactional outbox); a RabbitMQ worker performs background processing.

All successful responses use:

```json
{
  "success": true,
  "data": {}
}
```

All error responses use:

```json
{
  "success": false,
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable message"
  }
}
```

Every response includes `X-Request-ID`. Send the same header to correlate client logs with server logs. If omitted, the server generates a UUID v4. That value is stored on the payment as `requestId` and reused on every lifecycle event (`payment.created`, `payment.processing`, `payment.completed`, `payment.failed`), including events produced by PATCH.

Payment identifiers are **UUID v4**. Other UUID versions are rejected with `400 VALIDATION_ERROR`.

---

## POST /payments

Create a payment. The handler persists the payment as `pending`, writes a pending `payment.created` outbox record, and returns immediately. The API process later publishes that record to RabbitMQ on a confirm channel. A worker consumes the event, simulates processing, and records `payment.processing` then `payment.completed` or `payment.failed`.

### Idempotency

If `Idempotency-Key` is present, the payment, the key mapping, and the outbox record are written under one coordinated file lock:

- New key: create exactly one payment.
- Same key and same body: return the original payment (`200`).
- Same key and different body: `409 IDEMPOTENCY_CONFLICT`.
- If a later write fails, earlier writes are rolled back so a retry cannot create a second payment.

This is a JSON transactional outbox with cross-process file locks. It is not a distributed or crash-recovery database transaction.

### Headers

| Header | Required | Description |
| --- | --- | --- |
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | No | Client-generated key that makes create retries safe |
| `X-Request-ID` | No | Correlation ID stored on the payment and used in background logs |

### Request body

| Field | Type | Rules |
| --- | --- | --- |
| `amount` | number | Must be greater than zero |
| `currency` | string | 3 uppercase letters, e.g. `USD` |
| `customerId` | string | Non-empty |

### Success — 201 Created

Returned when a new payment is created.

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

### Success — 200 OK

Returned when `Idempotency-Key` matches a previous request with the same payload. The original payment is replayed; a second charge is not created.

### Error responses

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid or missing fields |
| 409 | `IDEMPOTENCY_CONFLICT` | Same idempotency key, different payload |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

### Example

```bash
curl -s -X POST http://localhost:3000/payments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"amount":49.99,"currency":"USD","customerId":"cus_123"}'
```

---

## GET /payments/:paymentId

Return a payment by ID.

### Headers

| Header | Required | Description |
| --- | --- | --- |
| `X-Request-ID` | No | Correlation ID |

### Path parameters

| Name | Rules |
| --- | --- |
| `paymentId` | UUID v4 |

### Success — 200 OK

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 49.99,
    "currency": "USD",
    "customerId": "cus_123",
    "status": "processing",
    "requestId": "3b5e2c1a-7c4f-4d2a-9e8b-1a2b3c4d5e6f",
    "createdAt": "2026-09-11T12:00:00.000Z",
    "updatedAt": "2026-09-11T12:00:02.000Z"
  }
}
```

### Error responses

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | `paymentId` is not a UUID v4 |
| 404 | `PAYMENT_NOT_FOUND` | No payment with that ID |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

### Example

```bash
curl -s http://localhost:3000/payments/550e8400-e29b-41d4-a716-446655440000
```

---

## PATCH /payments/:paymentId/status

Apply a status transition. Only legal finite-state-machine moves are accepted. Every successful PATCH enqueues the matching lifecycle event (`payment.processing`, `payment.completed`, or `payment.failed`) using the payment's original `requestId`.

### Valid transitions

| From | To |
| --- | --- |
| `pending` | `processing` |
| `processing` | `completed` |
| `processing` | `failed` |

`completed` and `failed` are terminal.

### Headers

| Header | Required | Description |
| --- | --- | --- |
| `Content-Type` | Yes | `application/json` |
| `X-Request-ID` | No | Correlation ID |

### Path parameters

| Name | Rules |
| --- | --- |
| `paymentId` | UUID v4 |

### Request body

```json
{
  "status": "processing"
}
```

`status` must be one of `pending`, `processing`, `completed`, `failed`. Values outside that set fail validation before the state machine runs.

### Success — 200 OK

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 49.99,
    "currency": "USD",
    "customerId": "cus_123",
    "status": "processing",
    "requestId": "3b5e2c1a-7c4f-4d2a-9e8b-1a2b3c4d5e6f",
    "createdAt": "2026-09-11T12:00:00.000Z",
    "updatedAt": "2026-09-11T12:00:01.000Z"
  }
}
```

### Error responses

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid UUID v4 or status |
| 404 | `PAYMENT_NOT_FOUND` | No payment with that ID |
| 409 | `INVALID_STATE_TRANSITION` | Transition is not allowed |
| 500 | `INTERNAL_ERROR` | Unexpected failure |

Example 409 body:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Cannot transition from completed to pending."
  }
}
```

### Example

```bash
curl -s -X PATCH http://localhost:3000/payments/550e8400-e29b-41d4-a716-446655440000/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"processing"}'
```

---

## Unknown routes

Requests that do not match an endpoint return:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Cannot GET /unknown"
  }
}
```

with HTTP status `404`.
