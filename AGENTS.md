# AGENTS.md - MemoryBench Codebase Guide

## Project Overview

MemoryBench is a benchmarking framework for evaluating memory/context layer providers. It runs a pipeline:
**Ingest → Index → Search → Answer → Evaluate → Report**

The system is designed to be pluggable - you can mix any provider with any benchmark and any judge model.

## Directory Structure

```
src/
├── index.ts              # Entry point - calls CLI
├── cli/                  # Command-line interface
│   ├── index.ts          # Command router
│   └── commands/         # Individual commands (run, ingest, search, etc.)
├── providers/            # Memory provider implementations
│   ├── index.ts          # Provider factory & registry
│   ├── mem0/             # Mem0.ai provider
│   ├── supermemory/      # Supermemory provider
│   └── zep/              # Zep provider
├── benchmarks/           # Benchmark dataset loaders
│   ├── index.ts          # Benchmark factory & registry
│   ├── locomo/           # LoCoMo benchmark
│   ├── longmemeval/      # LongMemEval benchmark
│   └── convomem/         # ConvoMem benchmark
├── judges/               # LLM judges for evaluation
│   ├── index.ts          # Judge factory
│   ├── base.ts           # Shared judge logic
│   ├── openai.ts         # OpenAI judge
│   ├── anthropic.ts      # Anthropic judge
│   └── google.ts         # Google judge
├── orchestrator/         # Pipeline orchestration
│   ├── index.ts          # Main orchestrator class
│   ├── checkpoint.ts     # Checkpoint manager for run state
│   ├── batch.ts          # Batch utilities
│   └── phases/           # Individual pipeline phases
│       ├── ingest.ts
│       ├── indexing.ts
│       ├── search.ts
│       ├── answer.ts
│       ├── evaluate.ts
│       └── report.ts
├── types/                # TypeScript interfaces
│   ├── provider.ts       # Provider interface
│   ├── benchmark.ts      # Benchmark interface
│   ├── judge.ts          # Judge interface
│   ├── unified.ts        # Unified data types (sessions, questions, results)
│   ├── prompts.ts        # Prompt types
│   └── checkpoint.ts     # Checkpoint/run state types
├── prompts/
│   └── defaults.ts       # Default answer/judge prompts
├── utils/
│   ├── config.ts         # Environment config (API keys)
│   ├── logger.ts         # Console logger
│   └── models.ts         # Model aliases & resolution
└── server/               # Web UI backend (optional)
```

## Core Interfaces

### Provider Interface (`src/types/provider.ts`)

Every provider must implement:

```typescript
interface Provider {
    name: string
    prompts?: ProviderPrompts  // Optional custom prompts
    
    initialize(config: ProviderConfig): Promise<void>
    ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
    awaitIndexing(result: IngestResult, containerTag: string): Promise<void>
    search(query: string, options: SearchOptions): Promise<unknown[]>
    clear(containerTag: string): Promise<void>
}

interface ProviderConfig {
    apiKey: string
    baseUrl?: string
    [key: string]: unknown
}

interface IngestOptions {
    containerTag: string        // Unique ID for this question's data
    metadata?: Record<string, unknown>
}

interface IngestResult {
    documentIds: string[]       // IDs returned from provider
    taskIds?: string[]          // Optional async task IDs
}

interface SearchOptions {
    containerTag: string
    limit?: number
    threshold?: number
}
```

### Unified Data Types (`src/types/unified.ts`)

```typescript
interface UnifiedSession {
    sessionId: string
    messages: UnifiedMessage[]
    metadata?: Record<string, unknown>  // Often contains date, formattedDate
}

interface UnifiedMessage {
    role: "user" | "assistant"
    content: string
    timestamp?: string
    speaker?: string
}

interface UnifiedQuestion {
    questionId: string
    question: string
    questionType: string
    groundTruth: string
    haystackSessionIds: string[]
    metadata?: Record<string, unknown>
}
```

### Provider Prompts (`src/types/prompts.ts`)

Providers can customize answer generation and judge prompts:

```typescript
interface ProviderPrompts {
    answerPrompt?: string | ((question: string, context: unknown[], questionDate?: string) => string)
    judgePrompt?: (question: string, groundTruth: string, hypothesis: string) => Record<string, string>
}
```

## Adding a New Provider

### Step 1: Create Provider Directory

```
src/providers/graphlit/
├── index.ts      # Main provider class
└── prompts.ts    # Custom prompts (optional)
```

### Step 2: Implement Provider Class

```typescript
// src/providers/graphlit/index.ts
import type { Provider, ProviderConfig, IngestOptions, IngestResult, SearchOptions } from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { GRAPHLIT_PROMPTS } from "./prompts"

export class GraphlitProvider implements Provider {
    name = "graphlit"
    prompts = GRAPHLIT_PROMPTS  // Optional
    private client: YourClientType | null = null

    async initialize(config: ProviderConfig): Promise<void> {
        // Initialize your API client
        this.client = new YourClient({ apiKey: config.apiKey })
        logger.info(`Initialized Graphlit provider`)
    }

    async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
        if (!this.client) throw new Error("Provider not initialized")
        
        const documentIds: string[] = []
        
        for (const session of sessions) {
            // Transform session data to your provider's format
            // Each session has:
            //   - sessionId: string
            //   - messages: Array<{ role, content, speaker?, timestamp? }>
            //   - metadata: { date?: string, formattedDate?: string, ... }
            
            const result = await this.client.add({
                content: /* format session data */,
                containerTag: options.containerTag,
                metadata: { sessionId: session.sessionId, ...session.metadata },
            })
            
            documentIds.push(result.id)
        }
        
        return { documentIds }
    }

    async awaitIndexing(result: IngestResult, containerTag: string): Promise<void> {
        // Poll until indexing is complete
        // Some providers are synchronous (just return)
        // Others require polling status endpoints
        
        if (result.documentIds.length === 0) return
        
        const pollInterval = 2000
        const timeout = 300000
        
        for (const docId of result.documentIds) {
            const start = Date.now()
            while (Date.now() - start < timeout) {
                const status = await this.client.getStatus(docId)
                if (status === "done" || status === "failed") break
                await new Promise(r => setTimeout(r, pollInterval))
            }
        }
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        if (!this.client) throw new Error("Provider not initialized")
        
        const response = await this.client.search({
            query,
            containerTag: options.containerTag,
            limit: options.limit || 10,
            threshold: options.threshold || 0.3,
        })
        
        // Return array of results - can be any shape
        // The answer prompt will receive this array as context
        return response.results || []
    }

    async clear(containerTag: string): Promise<void> {
        if (!this.client) throw new Error("Provider not initialized")
        await this.client.delete(containerTag)
        logger.info(`Cleared data for: ${containerTag}`)
    }
}

export default GraphlitProvider
```

### Step 3: Custom Prompts (Optional)

```typescript
// src/providers/graphlit/prompts.ts
import type { ProviderPrompts } from "../../types/prompts"

// Custom answer prompt - receives search results and formats them
export function buildGraphlitAnswerPrompt(question: string, context: unknown[], questionDate?: string): string {
    // Format context however makes sense for your provider's response format
    const formattedContext = context.map((r, i) => {
        // r is whatever your search() method returns
        return `[${i + 1}] ${JSON.stringify(r)}`
    }).join("\n\n")

    return `Your custom prompt here...
    
Question: ${question}
Context:
${formattedContext}

Answer:`
}

export const GRAPHLIT_PROMPTS: ProviderPrompts = {
    answerPrompt: buildGraphlitAnswerPrompt,
    // judgePrompt is optional - defaults work well for most cases
}
```

### Step 4: Register Provider

Update `src/providers/index.ts`:

```typescript
import type { Provider, ProviderName } from "../types/provider"
import { SupermemoryProvider } from "./supermemory"
import { Mem0Provider } from "./mem0"
import { ZepProvider } from "./zep"
import { GraphlitProvider } from "./graphlit"  // Add import

const providers: Record<ProviderName, new () => Provider> = {
    supermemory: SupermemoryProvider,
    mem0: Mem0Provider,
    zep: ZepProvider,
    graphlit: GraphlitProvider,  // Add to registry
}
// ... rest of file unchanged
```

### Step 5: Update Type Definition

Update `src/types/provider.ts`:

```typescript
export type ProviderName = "supermemory" | "mem0" | "zep" | "graphlit"
```

### Step 6: Add Config

Update `src/utils/config.ts`:

```typescript
export interface Config {
    // ... existing keys
    graphlitApiKey: string
}

export const config: Config = {
    // ... existing values
    graphlitApiKey: process.env.GRAPHLIT_API_KEY || "",
}

export function getProviderConfig(provider: string): { apiKey: string; baseUrl?: string } {
    switch (provider) {
        // ... existing cases
        case "graphlit":
            return { apiKey: config.graphlitApiKey }
        default:
            throw new Error(`Unknown provider: ${provider}`)
    }
}
```

### Step 7: Install SDK (if needed)

Add your SDK to package.json:
```bash
bun add graphlit-client  # or whatever your SDK is
```

## Key Implementation Notes

### Container Tags
Each question gets a unique `containerTag` = `{questionId}-{dataSourceRunId}`. This isolates data per question so search results only return relevant sessions.

### Session Ingestion
Sessions typically contain conversational data with dates. Providers like Supermemory store the raw JSON, Mem0 extracts memories, Zep creates a knowledge graph. Choose the approach that fits your provider.

### Search Results Format
The `search()` method can return any array. The answer phase receives this array and formats it into a prompt. If you have custom prompts, you control the formatting.

### Indexing Wait
Some providers are async (Mem0, Supermemory) - you need to poll until indexing completes. Others (Zep) are mostly synchronous. Implement `awaitIndexing` accordingly.

### Rate Limiting
The ingest phase has a built-in 1-second delay between sessions. Add additional rate limiting in your provider if needed.

## Pipeline Flow

1. **Ingest Phase** (`orchestrator/phases/ingest.ts`)
   - For each question, gets haystack sessions from benchmark
   - Calls `provider.ingest(sessions, { containerTag })`
   - Saves `IngestResult` to checkpoint

2. **Indexing Phase** (`orchestrator/phases/indexing.ts`)
   - Calls `provider.awaitIndexing(ingestResult, containerTag)`
   - Blocks until provider confirms indexing complete

3. **Search Phase** (`orchestrator/phases/search.ts`)
   - Calls `provider.search(question.question, { containerTag, limit: 10 })`
   - Saves results to `data/runs/{runId}/results/{questionId}.json`

4. **Answer Phase** (`orchestrator/phases/answer.ts`)
   - Loads search results
   - Builds prompt using provider's custom prompt or default
   - Calls answering model (GPT-4o by default)
   - Saves hypothesis to checkpoint

5. **Evaluate Phase** (`orchestrator/phases/evaluate.ts`)
   - Builds judge prompt comparing hypothesis to ground truth
   - Calls judge model
   - Parses correct/incorrect label and explanation

6. **Report Phase** (`orchestrator/phases/report.ts`)
   - Aggregates scores by question type
   - Calculates latency stats
   - Saves to `data/runs/{runId}/report.json`

## Checkpointing

Runs persist state in `data/runs/{runId}/checkpoint.json`. Each question tracks phase status independently. Failed runs resume from last successful phase.

## Testing Your Provider

```bash
# Quick test with limited questions
bun run src/index.ts run -p graphlit -b locomo -l 5

# Test single question
bun run src/index.ts test -p graphlit -b locomo -q "123-1-q0"

# Check status
bun run src/index.ts status -r <run-id>

# View failures
bun run src/index.ts show-failures -r <run-id>
```

## Environment Variables

Required for your provider:
```
GRAPHLIT_API_KEY=your-key-here
```

Required for judges (at least one):
```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

## Existing Provider Patterns

### Supermemory
- Stores sessions as stringified JSON with date prefix
- Returns memories with chunks for detailed context
- Custom prompt extracts from both memory summaries and raw chunks

### Mem0
- Uses memory extraction with custom instructions
- Async mode with event polling for indexing
- Returns extracted memories (not raw sessions)

### Zep
- Creates knowledge graph with entities and edges
- Uses ontology for entity types
- Returns both edges (facts) and nodes (entities) from search
- Custom prompt formats facts with timestamps
