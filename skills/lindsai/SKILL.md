---
name: lindsai
description: Manage the linds.ai Personal Intelligence OS — WhatsApp connections (Evolution API), health checks, message search, bot status, and instance management.
homepage: https://doc.evolution-api.com
metadata: { "openclaw": { "emoji": "🧠", "requires": { "bins": ["curl", "docker"] } } }
---

# linds.ai — Personal Intelligence OS

Manage the linds.ai platform: WhatsApp connections via Evolution API, health checks, message search, and bot administration.

## Architecture Overview

linds.ai is a multi-service stack at `~/Botverse/linds.ai-chat`:

| Service             | Port  | Role                                                                  |
| ------------------- | ----- | --------------------------------------------------------------------- |
| **Evolution API**   | 8080  | WhatsApp connection manager (multi-instance, Baileys-based)           |
| **linds-core**      | 3000  | Express.js brain: RAG, bot logic, admin UI (`/admin`), ingest webhook |
| **Supabase**        | 54321 | Postgres + pgvector — messages, contacts, embeddings                  |
| **n8n**             | 5678  | Automation workflows                                                  |
| **Redis**           | 6379  | Evolution session cache                                               |
| **url-fetcher-mcp** | 3001  | Web content extraction for bot                                        |

All services use **host networking**. Docker Compose file: `~/Botverse/linds.ai-chat/docker-compose.yaml`

## Evolution API

### Auth

All Evolution API calls require the header:

```
apikey: change_me_to_something_secure_123
```

### Instances

Two WhatsApp instances (the "two-agent pattern"):

| Instance           | Type | Number               | Purpose                               |
| ------------------ | ---- | -------------------- | ------------------------------------- |
| `Lindsai-Whatsapp` | Bot  | +34711287929 (Nadia) | Auto-replies via bot.js when messaged |
| `Spy-UK`           | Spy  | +447449571782 (Fonz) | Passive ingestion only, no replies    |

The `BOT_INSTANCE_NAME` env var (default: `Lindsai-Whatsapp`) controls which instance triggers bot auto-replies in `src/routes/ingest.js`.

The Evolution config sets `CONFIG_SESSION_PHONE_CLIENT=Chrome`, so instances appear as **"Google Chrome (Chrome)"** in WhatsApp → Linked Devices.

### Key Endpoints

```bash
# Base URL
EVO=http://localhost:8080
KEY="apikey: change_me_to_something_secure_123"

# List all instances (with connection status, message counts, etc.)
curl -s "$EVO/instance/fetchInstances" -H "$KEY"

# Check connection state of a specific instance
curl -s "$EVO/instance/connectionState/{instanceName}" -H "$KEY"
# Returns: {"instance":{"instanceName":"...","state":"open|close|connecting"}}

# Connect / get QR code (triggers new QR if disconnected)
curl -s "$EVO/instance/connect/{instanceName}" -H "$KEY"
# Returns: {"pairingCode": null|"XXXX-XXXX", "code": "...", "base64": "data:image/png;base64,...", "count": N}
# - base64: QR code as PNG data URI — extract after comma, base64-decode to get image
# - count: how many QR codes have been generated (max 30, config: QRCODE_LIMIT)
# - pairingCode: phone-number pairing code (only if requested with ?number=XXXXXXXXXXX)
# ⚠️ QR codes expire in ~30 seconds! Generate fresh ones right before scanning.

# Create a new instance
curl -s -X POST "$EVO/instance/create" -H "$KEY" -H "Content-Type: application/json" \
  -d '{"instanceName":"MyInstance","integration":"WHATSAPP-BAILEYS"}'

# Delete an instance
curl -s -X DELETE "$EVO/instance/delete/{instanceName}" -H "$KEY"

# Send a text message
curl -s -X POST "$EVO/message/sendText/{instanceName}" -H "$KEY" -H "Content-Type: application/json" \
  -d '{"number":"447449571782","text":"Hello!"}'

# Send media (image/document/video)
curl -s -X POST "$EVO/message/sendMedia/{instanceName}" -H "$KEY" -H "Content-Type: application/json" \
  -d '{"number":"447449571782","mediatype":"document","mimetype":"application/pdf","caption":"Here","fileName":"doc.pdf","media":"<base64>"}'

# Fetch media from a message (get base64 of received media)
curl -s -X POST "$EVO/chat/getBase64FromMediaMessage/{instanceName}" -H "$KEY" -H "Content-Type: application/json" \
  -d '{"message":{"key":{...},"message":{...}}}'

# Set webhook for an instance
curl -s -X POST "$EVO/webhook/set/{instanceName}" -H "$KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"enabled":true,"url":"http://localhost:3000/webhook/ingest","events":["MESSAGES_UPSERT"]}}'
```

### Phone Number Pairing (No QR Needed)

If the user can't scan a QR (e.g., only has one phone), use phone-number pairing:

```bash
curl -s "$EVO/instance/connect/{instanceName}?number=447449571782" -H "$KEY"
# Returns: {"pairingCode": "ABCD-EFGH", ...}
```

The user then enters this code in WhatsApp → Linked Devices → **"Link with phone number instead"**.

⚠️ WhatsApp rate-limits pairing attempts. After multiple failures, wait 15-30 minutes.

## linds-core API

```bash
CORE=http://localhost:3000

# Health check (basic)
curl -s "$CORE/health"

# Health check (full, includes Evolution connection state)
curl -s "$CORE/health?full=true"

# List agents (enriched: type, number, associated user)
curl -s "$CORE/api/agents"

# Proxy to Evolution (avoids CORS, hides API key)
curl -s "$CORE/api/proxy/instances"
curl -s "$CORE/api/proxy/instance/connect/{name}"
```

## Query API

### 🏆 Smart Query (Recommended — Start Here)

The `/api/query` endpoint is the easiest way to query WhatsApp memory. It detects intent from natural language and routes to the right backend automatically.

```bash
CORE=http://localhost:3000

# Ask any question — the router picks the right strategy
curl -s -X POST "$CORE/api/query" \
  -H "Content-Type: application/json" \
  -d '{"q":"summarise latest warner doc","user":"fonz"}' | jq .
# Returns: { answer: "...", intent: "document|unanswered|search|world-state|sender-search", sources: [...] }

# More examples:
curl -s -X POST "$CORE/api/query" -H "Content-Type: application/json" -d '{"q":"is anyone waiting for me?","user":"fonz"}'
curl -s -X POST "$CORE/api/query" -H "Content-Type: application/json" -d '{"q":"what did warner say about pricing?","user":"fonz"}'
curl -s -X POST "$CORE/api/query" -H "Content-Type: application/json" -d '{"q":"who sent me PDFs this week?","user":"fonz"}'
curl -s -X POST "$CORE/api/query" -H "Content-Type: application/json" -d '{"q":"whats going on?","user":"fonz"}'
```

The `answer` field is a pre-formatted text string you can return directly to the user.

### Direct Endpoints

For more control, use specific endpoints:

```bash
CORE=http://localhost:3000

# Semantic search (745K+ messages, vector similarity)
curl -s "$CORE/api/search?q=apartment+rental&limit=5&user=fonz" | jq .
# Optional: sender=<name>, threshold=0.3, after=<ISO>, before=<ISO>, explain=true
# Returns snippet, conversation_title, total_with_embeddings

# World state — conversation overview + highlights
curl -s "$CORE/api/world-state?user=fonz&hours=24" | jq .

# Unanswered questions (scored: urgency 🔴🟡🟢)
curl -s "$CORE/api/unanswered?user=fonz&hours=48&scored=true" | jq .

# Document content — full text + summary for any document message
curl -s "$CORE/api/documents/<message-uuid>/content" | jq .

# Enhanced document search — returns summaries alongside metadata
curl -s "$CORE/api/documents/search?q=valuation+report&user=fonz" | jq .

# Contact search
curl -s "$CORE/api/contacts/search?q=Alex" | jq .

# Conversation messages
curl -s "$CORE/api/conversations/<uuid>/messages?limit=30&user=fonz" | jq .

# Conversation stats — message count, participants, avg/day
curl -s "$CORE/api/conversations/<uuid>/stats" | jq .

# Global stats — total msgs, convos, embedding coverage, monthly breakdown
curl -s "$CORE/api/stats?user=fonz" | jq .
```

### Advanced Endpoints

```bash
# Batch conversation messages — multi-conversation in one call
curl -s -X POST "$CORE/api/conversations/batch/messages" \
  -H "Content-Type: application/json" \
  -d '{"conversation_ids":["uuid1","uuid2"],"limit_per":20,"user":"fonz"}' | jq .

# Message context — surrounding messages for a search hit
curl -s "$CORE/api/messages/<message-uuid>/context?before=5&after=5" | jq .

# Conversation summary — LLM-generated (cached 30min)
curl -s "$CORE/api/conversations/<uuid>/summary?hours=24&user=fonz" | jq .

# System health — embedding coverage, Evolution status, 7-day ingest
curl -s "$CORE/api/admin/health" | jq .

# Backfill embeddings (admin, batch=500 recommended)
curl -s -X POST "$CORE/api/admin/backfill-embeddings" \
  -H "Content-Type: application/json" \
  -d '{"batch_size":500}' | jq .
```

## Complex Queries (RLM Pattern)

For simple questions (world state, search), call the API directly with curl.

For analytical questions that span multiple conversations — like "Who's waiting for me and what's most urgent?" or "Summarize everything about the apartment situation" — use the **spawn pattern**: delegate to fast, cheap sub-agents that query the API in parallel.

### When to Query Directly vs. Spawn

| Question Type               | Strategy          | Example                                                                |
| --------------------------- | ----------------- | ---------------------------------------------------------------------- |
| Simple lookup               | Direct curl       | "How many active chats?" → `/api/world-state`                          |
| Single search               | Direct curl       | "What did Alex say about dinner?" → `/api/search?q=dinner&sender=Alex` |
| Multi-conversation analysis | **Spawn workers** | "Who's waiting for me? Prioritize."                                    |
| Cross-conversation research | **Spawn workers** | "What's the full story with the apartment?"                            |
| Batch classification        | **Spawn workers** | "What did I forget to follow up on this week?"                         |

### Spawn Template: Conversation Analysis

```
sessions_spawn({
  task: `You are a WhatsApp conversation analyzer. Use curl to query the linds.ai API at http://localhost:3000.

Conversations to analyze:
- <conv_id_1>: "<title>"
- <conv_id_2>: "<title>"
- <conv_id_3>: "<title>"

For each conversation:
1. Run: curl -s "http://localhost:3000/api/conversations/<id>/messages?limit=30&user=fonz"
2. Identify questions or requests directed at Fonz that haven't been answered
3. Assess urgency: high (>24h or explicit urgency), medium (>4h), low (recent)

Return a JSON array:
[{
  "conversation": "title",
  "sender": "name",
  "question": "what they asked",
  "urgency": "high|medium|low",
  "context": "1-sentence context",
  "suggestion": "what Fonz should do"
}]

Only include genuinely unanswered items. Be strict.`,
  model: "anthropic/claude-sonnet-4-20250514",
  thinking: "low",
  label: "lindsai-worker"
})
```

### Spawn Template: Topic Research

```
sessions_spawn({
  task: `Research a topic across WhatsApp conversations using the linds.ai API at http://localhost:3000.

Topic: "<topic>"

Steps:
1. Search: curl -s "http://localhost:3000/api/search?q=<topic>&limit=15&user=fonz"
2. For each unique conversation in results, get context:
   curl -s "http://localhost:3000/api/messages/<msg_id>/context?before=5&after=5"
3. Synthesize: who said what, when, what was decided, what's still open

Return a structured summary with timeline, key people, decisions, and open items.`,
  model: "anthropic/claude-sonnet-4-20250514",
  thinking: "low",
  label: "lindsai-researcher"
})
```

### Execution Flow

1. **Root agent** (Opus) receives user question
2. Calls `/api/unanswered?scored=true` or `/api/world-state` to get the landscape
3. Groups conversations into batches of 3-5
4. Spawns Sonnet workers for each batch (parallel, ~$0.01 each)
5. Workers call the API independently, analyze, return structured results
6. Root collects all results, synthesizes final answer

Workers can spawn sub-workers if they need deeper analysis (e.g., reading a document found in a conversation). Max concurrency: 8 sub-agents.

## Docker Management

```bash
cd ~/Botverse/linds.ai-chat

# Check running services
docker compose ps

# View logs
docker compose logs -f linds-core        # Bot/ingest logs
docker compose logs -f evolution-api     # WhatsApp connection logs
docker compose logs --tail=50 linds-core # Last 50 lines

# Restart a service
docker compose restart linds-core
docker compose restart evolution-api

# Restart everything
docker compose down && docker compose up -d

# Rebuild after code changes
docker compose build linds-core && docker compose up -d linds-core
```

## Supabase

```bash
cd ~/Botverse/linds.ai-chat

# Start Supabase (if not running)
npx supabase start

# Studio UI
open http://localhost:54322

# Direct SQL
npx supabase db query "SELECT count(*) FROM messages"
```

Key tables: `messages`, `contacts`, `participants`, `conversations`, `summaries`, `attachments`, `user_identities`, `documents`

## Common Operations

### Check Overall Health

```bash
# 1. Docker services running?
cd ~/Botverse/linds.ai-chat && docker compose ps

# 2. Evolution API alive?
curl -s http://localhost:8080/ -H "apikey: change_me_to_something_secure_123" | jq .version

# 3. WhatsApp instances connected?
curl -s http://localhost:8080/instance/fetchInstances -H "apikey: change_me_to_something_secure_123" | jq '.[].connectionStatus'

# 4. linds-core healthy?
curl -s http://localhost:3000/health?full=true | jq .

# 5. Supabase alive?
curl -s http://localhost:54321/rest/v1/ -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU" | head -c 100
```

### Reconnect a WhatsApp Instance

```bash
# 1. Check current state
curl -s "http://localhost:8080/instance/connectionState/Spy-UK" -H "apikey: change_me_to_something_secure_123"

# 2. If "close" or "connecting", generate QR
curl -s "http://localhost:8080/instance/connect/Spy-UK" -H "apikey: change_me_to_something_secure_123" | python3 -c "
import json, base64, sys
data = json.load(sys.stdin)
b64 = data['base64'].split(',', 1)[1]
with open('/tmp/evo_qr.png', 'wb') as f:
    f.write(base64.b64decode(b64))
print(f'QR saved to /tmp/evo_qr.png (attempt {data[\"count\"]})')
"

# 3. Send QR image to user (via message tool or other means)
# 4. User scans with WhatsApp → Linked Devices → Link a Device
# 5. Verify connection
curl -s "http://localhost:8080/instance/connectionState/Spy-UK" -H "apikey: change_me_to_something_secure_123"
```

### Phone Number Pairing (When QR Scan Not Possible)

```bash
# Generate pairing code instead of QR
curl -s "http://localhost:8080/instance/connect/Spy-UK?number=447449571782" \
  -H "apikey: change_me_to_something_secure_123" | jq .pairingCode
# User opens WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"
# Enter the pairing code shown
```

### Search Messages

```bash
# Via Supabase direct query (recent messages)
curl -s "http://localhost:54321/rest/v1/messages?select=content,created_at,is_outgoing&order=created_at.desc&limit=10" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
```

## Troubleshooting

### Instance shows "close" with `device_removed`

The WhatsApp linked device was removed (either manually from phone or by WhatsApp).
**Fix:** Re-pair using QR code or phone number pairing code. If rate-limited, wait 15-30 min.

### Instance stuck on "connecting"

Evolution API is trying to reconnect but the session is stale.
**Fix:**

1. Delete the instance: `curl -X DELETE ".../instance/delete/{name}" -H "apikey: ..."`
2. Recreate: `curl -X POST ".../instance/create" -H "apikey: ..." -d '{"instanceName":"...","integration":"WHATSAPP-BAILEYS"}'`
3. Re-pair with QR

### Bot not replying

1. Check the bot instance is connected: `connectionState/Lindsai-Whatsapp`
2. Check webhook is set: look at Evolution instance config for webhook URL pointing to `http://localhost:3000/webhook/ingest`
3. Check linds-core logs: `docker compose logs -f linds-core | grep -i bot`
4. Verify `BOT_INSTANCE_NAME` env var matches the bot instance name

### Messages not being ingested

1. Verify webhook: Evolution → linds-core webhook must be configured for `MESSAGES_UPSERT` event
2. Check ingest route logs: `docker compose logs -f linds-core | grep -i ingest`
3. Verify Supabase is running: `curl http://localhost:54321/rest/v1/`

## Safety

- Never expose the Evolution API key publicly
- Don't delete instances without confirming with the user — session data is lost
- The Supabase service key has full access — treat it as a secret
- `whatsapp-api/auth_info_baileys/` contains WhatsApp session credentials — never share
