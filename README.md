# ContentOS (v0.1)

Multi-project, AI-powered content operations and workflow automation platform.

## Architecture
- **apps/web**: Next.js 15 + React 19 + TypeScript + Tailwind CSS dashboard (Port 3000)
- **apps/api**: Express + TypeScript REST API with HTTP-only session cookies, RBAC, and Transactional Outbox (Port 4000)
- **apps/worker**: BullMQ + Redis background worker & outbox dispatcher
- **packages/database**: PostgreSQL + Prisma ORM schema, migrations, and seed data
- **packages/shared**: Shared Zod validation schemas, enums, and domain errors
- **packages/workflow-engine**: Typed stage registry and stage execution handlers
- **packages/ai-provider**: LLM provider abstraction (Gemini-ready + Simulated v0.1 provider)

## Prerequisites
- Node.js >= 20
- pnpm >= 10
- PostgreSQL 16+
- Redis 7+

## Installation
1. Install workspace dependencies:
   pnpm install

2. Configure environment variables:
   Copy .env.example to .env and set DATABASE_URL, REDIS_URL, and SESSION_SECRET.

3. Generate Prisma client, push schema, and seed demo data:
   pnpm db:generate
   pnpm db:push
   pnpm db:seed

## Running Locally (3 Independent Processes)
- Terminal 1 (API Server):
  pnpm --filter @contentos/api dev

- Terminal 2 (BullMQ Worker):
  pnpm --filter @contentos/worker dev

- Terminal 3 (Next.js Dashboard):
  pnpm --filter @contentos/web dev

Demo account (created by seed):
- Email: founder@contentos.dev
- Password: ContentOS2026!

## Testing & Verification
- Typecheck all packages and apps:
  pnpm typecheck

- Run API & tenant isolation integration tests:
  pnpm test

- Build all production bundles:
  pnpm build

## Deployment Preparation
Each runtime deploys independently from this monorepo:
- Web: pnpm --filter @contentos/web build && pnpm --filter @contentos/web start
- API: pnpm --filter @contentos/api build && pnpm --filter @contentos/api start
- Worker: pnpm --filter @contentos/worker build && pnpm --filter @contentos/worker start

## Local-First AI Infrastructure (Ollama on Windows)

ContentOS defaults to local inference via **Ollama** (`http://localhost:11434`) so you can run full AI workflows with zero paid API keys.

### 1. Install Ollama & Pull Models (RTX 2050 4GB VRAM Optimized)
```powershell
# Install via winget (or download from [https://ollama.com/download/windows](https://ollama.com/download/windows))
winget install Ollama.Ollama

# Pull the default task-routed models (~2.0GB - 2.6GB each, fits 4GB VRAM):
ollama pull qwen3:4b
ollama pull llama3.2:3b
ollama pull qwen2.5-coder:3b
```

### 2. Task-to-Model Routing Defaults
- `script_generation` / `content_ideas` / `content_rewriting` -> `qwen3:4b`
- `classification` / `summarization` -> `llama3.2:3b`
- `basic_coding` -> `qwen2.5-coder:3b`

### 3. AI Infrastructure Endpoints
- `GET /api/ai/health` ? Ollama daemon status, latency, and active provider
- `GET /api/ai/providers` ? Configured providers (`ollama`, optional `gemini`)
- `GET /api/ai/models` ? Model registry, capabilities, task routes, and prompt versions
- `GET /api/ai/models/installed` ? Live check of locally pulled Ollama models
- `POST /api/ai/models/select` ? Reassign a task to a different provider/model (logged)
- `POST /api/workflows/script-generation` ? Queue a BullMQ script generation workflow
