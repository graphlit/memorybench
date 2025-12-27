import type { ProviderPrompts } from "../../types/prompts"

interface GraphlitSource {
    content?: {
        id?: string
        name?: string
    }
    text?: string
    relevance?: number
}

function formatSource(source: GraphlitSource, index: number): string {
    const header = `[${index + 1}]`
    
    if (source.text) {
        return `${header}\n${source.text}`
    }
    
    return header
}

export function buildGraphlitAnswerPrompt(
    question: string,
    context: unknown[],
    questionDate?: string
): string {
    const sources = context as GraphlitSource[]

    if (sources.length === 0) {
        return `You are a helpful question-answering assistant.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

No relevant context was found.

Answer: I don't know`
    }

    const formattedSources = sources
        .map((source, i) => formatSource(source, i))
        .join("\n\n---\n\n")

    return `You are a helpful question-answering assistant.

Use the retrieved context below as the primary source of truth.
Answer naturally and concisely, as a human would, based on the information provided.

Guidelines:
- Prefer information explicitly stated in the context
- ALWAYS normalize relative time expressions to absolute dates/years using the timestamps in context
  (e.g., if context is from 2023 and says "last year", answer with "2022" not "last year")
- When multiple relevant items are present, include all of them, especially when they form a natural grouping or category
- For "what/who/where" questions, scan ALL retrieved results for mentions - don't stop at the first few
- Recognize equivalent expressions (e.g., "school event where I talked" = giving a speech, "went swimming" = swimming activity)
- When a question asks for a likely judgment, answer based on strong contextual evidence
- If the answer cannot reasonably be determined from the context, say "I don't know"

When multiple similar events, activities, or instances appear in the context:
- Use any constraints stated in the question (time, ordering, conditions) to select the best-matching instance
- Prefer the instance that satisfies phrases like "before", "after", "during", "that summer", or specific reference dates
- Do NOT automatically choose the most recent or most prominent instance if it does not satisfy the question's constraints

Question:
${question}

Question Date:
${questionDate || "Not specified"}

Retrieved Context:
${formattedSources}

Answer:
`
}

export const GRAPHLIT_PROMPTS: ProviderPrompts = {
    answerPrompt: buildGraphlitAnswerPrompt,
}

export default GRAPHLIT_PROMPTS
