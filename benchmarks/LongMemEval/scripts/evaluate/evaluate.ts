/*
Evaluation script for LongMemEval results.
Uses a default model (gemini-3-pro-preview) to evaluate answer quality.
*/

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createVertex } from '@ai-sdk/google-vertex/edge';
import { generateText } from 'ai';
import { config, validateConfig } from '../utils/config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

validateConfig(['googleVertexProjectId']);

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error("Usage: bun run evaluate.ts <runId> [questionType]");
    console.error("Example: bun run evaluate.ts run1");
    console.error("Example: bun run evaluate.ts run1 single-session-user");
    process.exit(1);
}

const runId = args[0];
let questionTypeFilter = args[1]; // Optional
const startPosition = args[2] ? parseInt(args[2], 10) : undefined;
const endPosition = args[3] ? parseInt(args[3], 10) : undefined;

if (questionTypeFilter === 'all') {
    questionTypeFilter = undefined;
}

// Fixed model
const model = 'gemini-3-pro-preview';

console.log(`Evaluating results for: ${runId}`);
if (questionTypeFilter) {
    console.log(`Question type filter: ${questionTypeFilter}`);
} else {
    console.log(`Question type filter: all`);
}

if (startPosition && endPosition) {
    console.log(`Processing range: ${startPosition} to ${endPosition}`);
}

console.log(`Using model: ${model}`);
console.log(`Using ALL retrieved results from each file\n`);

const vertex = createVertex({
    project: config.googleVertexProjectId,
    location: "global",
});

// Setup directories
const resultsDir = join(__dirname, '../../results');
const evalDir = join(__dirname, '../../evaluations');

if (!existsSync(evalDir)) {
    mkdirSync(evalDir, { recursive: true });
}

// Find all result files for this runId
let resultFiles = readdirSync(resultsDir)
    .filter(f => f.endsWith('.json') && f.includes(`-${runId}`))
    .sort();

// Filter by question type if specified
if (questionTypeFilter) {
    const filteredFiles: string[] = [];
    for (const filename of resultFiles) {
        const filePath = join(resultsDir, filename);
        try {
            const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
            if (resultData.metadata?.questionType === questionTypeFilter) {
                filteredFiles.push(filename);
            }
        } catch (error) {
            // Skip files that can't be parsed
            console.warn(`Warning: Could not parse ${filename}, skipping...`);
        }
    }
    resultFiles = filteredFiles;
    
    if (resultFiles.length === 0) {
        console.error(`No result files found for runId: ${runId} and questionType: ${questionTypeFilter}`);
        console.error(`Looking in: ${resultsDir}`);
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files to evaluate (filtered by type: ${questionTypeFilter})\n`);
} else {
    if (resultFiles.length === 0) {
        console.error(`No result files found for runId: ${runId}`);
        console.error(`Looking in: ${resultsDir}`);
        process.exit(1);
    }
    
    console.log(`Found ${resultFiles.length} result files to evaluate\n`);
}

// Filter by position range if specified
if (startPosition !== undefined && endPosition !== undefined) {
    if (isNaN(startPosition) || isNaN(endPosition) || startPosition < 1 || endPosition < startPosition) {
        console.error(`Invalid range: ${startPosition}-${endPosition}`);
        process.exit(1);
    }
    
    // positions are 1-based
    const totalBeforeSlice = resultFiles.length;
    resultFiles = resultFiles.slice(startPosition - 1, endPosition);
    console.log(`Filtered to range ${startPosition}-${endPosition}: ${resultFiles.length} files (out of ${totalBeforeSlice})`);
}

// Output file path
const typeSuffix = questionTypeFilter ? `-${questionTypeFilter}` : '';
const rangeSuffix = (startPosition && endPosition) ? `-${startPosition}-${endPosition}` : '-all';
const outputFilename = `eval-${runId}${typeSuffix}${rangeSuffix}.json`;
const outputPath = join(evalDir, outputFilename);

interface EvaluationResult {
    questionId: string;
    questionType: string;
    question: string;
    groundTruth: string;
    hypothesis: string;
    label: number; // 1 = correct, 0 = incorrect
    explanation: string;
}

interface Chunk {
    content: string;
    position: number;
    [key: string]: any;
}

function deduplicateAndSortChunks(chunks: Chunk[]): Chunk[] {
    const uniqueChunks = chunks.filter((chunk, index, self) =>
        index === self.findIndex((c) => c.content === chunk.content)
    );
    return uniqueChunks.sort((a, b) => a.position - b.position);
}

async function generateAnswer(question: string, retrievedContext: string, questionDate?: string): Promise<string> {
    const answerPrompt = `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate}

Retrieved Context:
${retrievedContext}

**Understanding the Context:**
The context contains search results from a memory system. Each result has multiple components you can use:

1. **Memory**: A high-level summary/atomic fact (e.g., "Alex loves hiking in mountains", "John reports to Maria")
   - This is the searchable title/summary of what was stored

2. **Chunks**: The actual detailed raw content where the memory was extracted from
   - Contains conversations, documents, messages, or text excerpts
   - **This is your primary source for detailed information and facts**
   - Look here for specifics, context, quotes, and evidence

3. **Temporal Context** (if present):
   - **Question Date**: The date when the question was asked (provided above). Use this to understand the temporal perspective of the question.
   - **documentDate**: ISO date string for when the content was originally authored/written/said by the user (NOT the system createdAt timestamp). This is the reference point for calculating relative dates. Extract from document metadata, timestamps, or context.
   - **eventDate**: Array of ISO date strings for when the event/fact being referenced actually occurred or will occur. Always provided as an array, even for single dates. For past events use past dates, for future events use future dates. Calculate relative dates (today, yesterday, last week) based on documentDate, NOT the current date.
   - Useful for time-based questions (what happened when, recent vs old info)
   - **Important**: When you see relative terms like "today", "yesterday", calculate them relative to the documentDate, NOT the current date. The question date helps you understand the temporal context of what the user is asking about.

4. **Profile Data** (if present):
   - **Static Profile**: Permanent user characteristics (name, preferences, core identity)
   - **Dynamic Profile**: Contains a subset of the recently added memories
   - Provides background about the user

5. **Version**: Shows if a memory has been updated/extended over time

**How to Answer:**
1. Start by scanning memory titles to find relevant results
2. **Read the chunks carefully** - they contain the actual details you need
3. Use temporal context to understand when things happened
4. Use profile data for background about the user
5. Synthesize information from multiple results if needed

Instructions:
- If the context contains enough information to answer the question, provide a clear, concise answer
- If the context does not contain enough information, respond with "I don't know" or explain what information is missing
- Base your answer ONLY on the provided context
- **Prioritize information from chunks** - they're the raw source material

Answer:`;

    try {
        const result = await generateText({
            model: vertex(model),
            messages: [{ role: 'user', content: answerPrompt }],
        });
        return result.text.trim();
    } catch (error) {
        return `Error generating answer: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function judgeAnswer(
    question: string,
    groundTruth: string,
    hypothesis: string
): Promise<{ label: number; explanation: string }> {
    const judgementPrompt = `You are an expert language model evaluator. Your task is to determine if a model-generated response correctly answers a given question, based on a ground-truth answer.

**Evaluation Rules:**

**Answer Yes (label: 1) if:**
- The response contains or directly matches the correct answer
- The response includes all necessary intermediate steps leading to the correct answer

**Answer No (label: 0) if:**
- The response provides only a partial answer or omits essential information
- The response does not sufficiently address the question

**Examples:**

**Example 1: Correct Response**
Question: "What is the capital of France?"
Ground-truth Answer: "Paris"
Response: "The capital of France is Paris."
Evaluation Output: Yes (label: 1)

**Example 2: Incorrect Response**
Question: "What is the capital of France?"
Ground-truth Answer: "Paris"
Response: "France is a country in Europe."
Evaluation Output: No (label: 0)

**General Instructions:**
- Base your decision strictly on the information in the response
- Avoid subjective interpretations and adhere to the provided examples
- Apply the evaluation criteria consistently

**Input:**
Question: ${question}

Ground-truth Answer: ${groundTruth}

Response: ${hypothesis}

**Output:**
Respond in the following JSON format:
{
  "label": 0 or 1,
  "explanation": "Brief explanation of your decision"
}`;

    try {
        const result = await generateText({
            model: vertex(model),
            messages: [{ role: 'user', content: judgementPrompt }],
        });

        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Failed to parse JSON from model response');

        const parsed = JSON.parse(jsonMatch[0]);
        return {
            label: parsed.label,
            explanation: parsed.explanation,
        };
    } catch (error) {
        return {
            label: 0,
            explanation: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

async function evaluateQuestion(resultData: any): Promise<EvaluationResult> {
    const { metadata, searchResults } = resultData;
    
    const allResults = (searchResults.results || []);
    const allChunks: Chunk[] = [];
    for (const result of allResults) {
        const chunks = result.chunks || [];
        for (const chunk of chunks) {
            allChunks.push({
                content: chunk.content,
                position: chunk.position ?? 0,
                ...chunk
            });
        }
    }
    
    const deduplicatedChunks = deduplicateAndSortChunks(allChunks);
    
    const memoriesSection = allResults
        .map((result: any, i: number) => {
            const memory = result.memory || '';
            const temporalContext = result.metadata?.temporalContext;
            const documentDate = temporalContext?.documentDate;
            const eventDate = temporalContext?.eventDate;
            
            let memoryParts = [`Result ${i + 1}:`, memory];
            
            if (documentDate || eventDate) {
                const temporalInfo: string[] = [];
                if (documentDate) temporalInfo.push(`documentDate: ${documentDate}`);
                if (eventDate) {
                    const eventDates = Array.isArray(eventDate) ? eventDate : [eventDate];
                    temporalInfo.push(`eventDate: ${eventDates.join(', ')}`);
                }
                memoryParts.push(`Temporal Context: ${temporalInfo.join(' | ')}`);
            }
            
            return memoryParts.join('\n');
        })
        .join('\n\n---\n\n');
    
    const chunksSection = deduplicatedChunks.length > 0
        ? `\n\n=== DEDUPLICATED CHUNKS ===\n${deduplicatedChunks.map(chunk => chunk.content).join('\n\n---\n\n')}`
        : '';
    
    const retrievedContext = memoriesSection + chunksSection;
    
    try {
        const hypothesis = await generateAnswer(metadata.question, retrievedContext, metadata.questionDate);
        const { label, explanation } = await judgeAnswer(metadata.question, metadata.groundTruthAnswer, hypothesis);
        
        return {
            questionId: metadata.questionId,
            questionType: metadata.questionType,
            question: metadata.question,
            groundTruth: metadata.groundTruthAnswer,
            hypothesis,
            label,
            explanation,
        };
    } catch (error) {
        console.error(`Error evaluating ${metadata.questionId}:`, error);
        return {
            questionId: metadata.questionId,
            questionType: metadata.questionType,
            question: metadata.question,
            groundTruth: metadata.groundTruthAnswer,
            hypothesis: '',
            label: 0,
            explanation: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

async function evaluateAll() {
    let evaluations: EvaluationResult[] = [];
    let processedQuestionIds = new Set<string>();
    
    if (existsSync(outputPath)) {
        try {
            const existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
            if (existing.evaluations && Array.isArray(existing.evaluations)) {
                evaluations = existing.evaluations;
                processedQuestionIds = new Set(evaluations.map((e: EvaluationResult) => e.questionId));
                console.log(`Resuming: Found ${evaluations.length} existing evaluations\n`);
            }
        } catch (error) {
            console.log(`Starting fresh evaluation\n`);
        }
    }
    
    for (const filename of resultFiles) {
        const filePath = join(resultsDir, filename);
        try {
            const resultData = JSON.parse(readFileSync(filePath, 'utf8'));
            const questionId = resultData.metadata.questionId;
            
            if (processedQuestionIds.has(questionId)) {
                console.log(`Skipping: ${questionId} (already evaluated)`);
                continue;
            }
            
            console.log(`Evaluating: ${questionId}`);
            const evaluation = await evaluateQuestion(resultData);
            evaluations.push(evaluation);
            
            // Calculate intermediate stats
            const total = evaluations.length;
            const correct = evaluations.filter(e => e.label === 1).length;
            const accuracy = total > 0 ? (correct / total) * 100 : 0;
            
            // Save
            const output = {
                metadata: {
                    runId,
                    model,
                    evaluatedAt: new Date().toISOString(),
                    totalQuestions: total,
                    correctAnswers: correct,
                    accuracy: accuracy.toFixed(2) + '%',
                },
                evaluations,
            };
            writeFileSync(outputPath, JSON.stringify(output, null, 2));
            
            // Log
            const status = evaluation.label === 1 ? '✓ CORRECT' : '✗ INCORRECT';
            console.log(`  ${status} - ${evaluation.explanation.substring(0, 60)}...`);
            console.log(`  Progress: ${total}/${resultFiles.length} | Accuracy: ${accuracy.toFixed(2)}%\n`);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`  Error processing ${filename}:`, error);
        }
    }
    
    // Final summary
    const total = evaluations.length;
    const correct = evaluations.filter(e => e.label === 1).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;
    
    console.log('='.repeat(60));
    console.log('EVALUATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Run ID:       ${runId}`);
    console.log(`Total:        ${total}`);
    console.log(`Correct:      ${correct}`);
    console.log(`Accuracy:     ${accuracy.toFixed(2)}%`);
    console.log('='.repeat(60));
}

await evaluateAll();
