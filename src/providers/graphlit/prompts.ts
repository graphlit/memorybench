import type { ProviderPrompts } from "../../types/prompts"

interface GraphlitSource {
    content?: {
        id?: string
        name?: string
        uri?: string
        type?: string
    }
    text?: string
    relevance?: number
    startTime?: string
    endTime?: string
    pageNumber?: number
}

function formatSource(source: GraphlitSource, index: number): string {
    const parts: string[] = []

    // Header with index and relevance
    const relevance = source.relevance !== undefined
        ? ` (relevance: ${(source.relevance * 100).toFixed(0)}%)`
        : ""
    parts.push(`[${index + 1}]${relevance}`)

    // Timestamp if available
    if (source.startTime) {
        parts.push(`Timestamp: ${source.startTime}`)
    }

    // Content name/context if available
    if (source.content?.name) {
        parts.push(`Source: ${source.content.name}`)
    }

    // The actual text content
    if (source.text) {
        parts.push(`\n${source.text}`)
    }

    return parts.join("\n")
}

export function buildGraphlitAnswerPrompt(question: string, context: unknown[], questionDate?: string): string {
    const sources = context as GraphlitSource[]

    if (sources.length === 0) {
        return `You are answering questions based on retrieved conversation memories.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

No relevant memories were found.

If you cannot answer based on the available information, respond with "I don't know".

Answer:`
    }

    const formattedSources = sources
        .map((source, i) => formatSource(source, i))
        .join("\n\n---\n\n")

    return `You are answering questions based on retrieved conversation memories.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Memories (ordered by relevance):
${formattedSources}

Instructions:
- Base your answer ONLY on the retrieved memories above
- Pay attention to timestamps when answering temporal questions (e.g., "when did...", "how long ago...")
- Convert relative time references to specific dates based on the timestamps provided
- If the question asks about something not present in the memories, respond with "I don't know"
- Be concise and direct in your answer
- Do not make up information that isn't in the memories

Answer:`
}

export const GRAPHLIT_PROMPTS: ProviderPrompts = {
    answerPrompt: buildGraphlitAnswerPrompt,
}

export default GRAPHLIT_PROMPTS
