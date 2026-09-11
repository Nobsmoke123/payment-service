# Payment Processing Simulation Microservice

An **event-driven payment simulation**. This service models the lifecycle of a payment; it does not move real money or talk to a card network.

Clients create, fetch, and transition payments over HTTP. The API writes the payment, idempotency mapping, and a pending outbox record in one JSON transaction, then returns immediately. An outbox publisher in the API process publishes confirmed events to RabbitMQ. A separate worker consumes `payment.created`, simulates processing, and records lifecycle events.

This is a **JSON transactional outbox**, not crash-proof distributed messaging. A hard crash mid-write can still leave files inconsistent. Recoverable broker failures no longer lose `payment.created`.

## Architecture

```text
                    Client
                      │
               POST /payments
                      │
                      ▼
              Payment Service
                      │
          Atomic JSON Transaction
      ┌─────────────┼──────────────┐
      ▼             ▼              ▼
payments.json  idempotency.json  outbox.json
                                     │
                                     ▼
                            Outbox Publisher
                                     │
                                     ▼
                          RabbitMQ Topic Exchange
                                     │
                                     ▼
                             Payment Worker
                                     │
                     processing/completed/failed
                                     │
                                     ▼
                               JSON Repository
```

HTTP remains responsible for validation, business rules, idempotency, and persistence. The outbox publisher is the only component that talks to the EventBus. The worker is responsible for background transitions. Controllers contain no domain logic.

## Runtime topology and failure behavior

Docker Compose runs one payment microservice in three containers:

- **api** is the HTTP entry point and the only process that runs the outbox publisher. It starts the application with the payment worker disabled.
- **worker** is the RabbitMQ consumer and asynchronous payment processor. It starts the application with the outbox publisher disabled.
- **rabbitmq** is the shared durable message broker.

The API and worker are separate OS processes and containers, so an API failure does not terminate an already-running worker. They are, however, two runtime roles of the same payment service rather than independent business microservices: they share the same codebase, domain model, and mounted JSON persistence files.

If the API is unavailable while the worker and RabbitMQ remain available:

- HTTP requests cannot be accepted, so no new payments can be created, queried, or manually updated through the API.
- Events already published to RabbitMQ can still be consumed and processed by the worker. The worker safely updates the shared payment data.
- Lifecycle events created by the worker are appended to the shared transactional outbox, but remain pending until the API returns because only the API runs the outbox publisher.
- A `payment.created` event committed to the outbox before an API failure is retained and replayed by the publisher when the API starts again.

If the worker is unavailable while the API and RabbitMQ remain available, the API can still create payments and publish their `payment.created` events. RabbitMQ retains those durable messages until the worker reconnects. The delivery model is at-least-once, so worker processing and state transitions are designed to tolerate duplicate delivery.

Both containers mount `./data` and coordinate JSON access with `proper-lockfile`, an in-process mutex, and atomic file replacement. This provides single-host, cross-process coordination for the Docker Compose simulation; it is not a distributed storage guarantee.

## Design decisions

- **Layered ports and adapters:** `PaymentService` depends on repositories and an `OutboxDispatcher`. It never imports RabbitMQ. Tests use an in-memory bus; production uses `RabbitMQEventBus`.
- **Transactional outbox:** `POST /payments` and every successful status transition write `outbox.json` under the same lock as the payment. Nothing is published until the outbox publisher gets a confirm-channel ack, then the record is marked `published`. Pending records are republished when the API starts.
- **JSON + OS file locks:** `proper-lockfile` coordinates the API and worker processes that share `data/*.json`. Writes still use temp-file + rename.
- **Idempotent creation:** `POST /payments` with `Idempotency-Key` commits the payment, key mapping, and outbox record together. Same key and payload replay the original payment (`200`). Same key and different payload returns `409`.
- **Finite state machine:** `pending → processing → completed | failed`. The worker uses `transitionIf`, so redelivered messages cannot complete a payment twice.
- **Dead letter queue:** Consumers validate every message with Zod. Valid events are processed and ACKed. Malformed events are published to `payments.dlq` and ACKed. They are never requeued forever.
- **Request correlation:** The originating `X-Request-ID` is stored on the payment and copied onto every domain event and worker log, including PATCH lifecycle events.
- **In-process tests vs Docker:** `npm test` does not require RabbitMQ. `docker compose up --build` runs API, worker, and RabbitMQ together.

This is still a single-node Docker Compose payment simulation. It is not multi-region messaging, Kafka, PostgreSQL, or a real card processor.

## Event flow

| Routing key | Producer | Consumer |
| --- | --- | --- |
| `payment.created` | API outbox (create) | Worker |
| `payment.processing` | Worker or PATCH | Logger |
| `payment.completed` | Worker or PATCH | Logger |
| `payment.failed` | Worker or PATCH | Logger |

Exchange: `payments.events` (topic). Invalid events: `payments.dlx` → `payments.dlq`.

## Folder structure

```text
src/
  controllers/
  services/
  repositories/    payments, idempotency, outbox, atomic create/transition
  routes/
  middleware/
  models/
  messaging/       EventBus, RabbitMQ, outbox publisher, Zod event schemas
  workers/         Payment worker process
  utils/
  app.ts
  server.ts

docker/
  api.Dockerfile
  worker.Dockerfile
docker-compose.yml
data/
  payments.json
  idempotency.json
  outbox.json
tests/
docs/
```

## Environment variables

Validated on startup. Invalid values fail fast.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | Pino log level |
| `PAYMENT_DELAY_MS` | `2000` | Simulated gateway delay (`3000` in Compose) |
| `CORS_ORIGIN` | `*` | Allowed CORS origin(s) |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PAYMENTS_FILE_PATH` | `data/payments.json` | Payment store |
| `IDEMPOTENCY_FILE_PATH` | `data/idempotency.json` | Idempotency store |
| `OUTBOX_FILE_PATH` | `data/outbox.json` | Transactional outbox store |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | Publisher poll interval |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Broker URL |
| `RABBITMQ_EXCHANGE` | `payments.events` | Topic exchange |
| `PAYMENT_QUEUE` | `payment.created` | Worker queue |
| `SERVICE_NAME` | `payment-api` | `payment-api`, `payment-worker`, or `event-bus` |

## Installation

```bash
npm install
```

Requires Node.js 18 or later.

## Running with Docker

```bash
docker compose up --build
```

- API: `http://localhost:3000`
- RabbitMQ Management UI: `http://localhost:15672` (username `guest`, password `guest`)

API and worker share `./data` so both processes read and write the same JSON files. Only the API process runs the outbox publisher.

## Running locally without Docker

Start RabbitMQ, then:

```bash
cp .env.example .env
npm run dev
```

In another terminal:

```bash
npm run dev:worker
```

Production-style:

```bash
npm run build
npm start
npm run worker
```

`SIGINT` / `SIGTERM` stop HTTP, finish the current worker message before ACK, close the RabbitMQ channel and connection, flush logs, and exit. On the next API start, any still-pending outbox records are published.

## Running tests

```bash
npm test
```

HTTP and worker tests use an in-memory event bus. If RabbitMQ is reachable at `RABBITMQ_URL`, messaging tests exercise a real broker, including DLQ routing. If the broker is down, those suites are registered with `describe.skip` so Jest reports them as **Skipped**, not Passed.

## API

See [docs/API.md](docs/API.md). Payment IDs are UUID v4.
