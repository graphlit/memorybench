import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { shouldStop } from "../../server/runState"

const DEFAULT_RATE_LIMIT_MS = 1000

export async function runIngestPhase(
    provider: Provider,
    benchmark: Benchmark,
    checkpoint: RunCheckpoint,
    checkpointManager: CheckpointManager,
    questionIds?: string[]
): Promise<void> {
    const questions = benchmark.getQuestions()
    const targetQuestions = questionIds
        ? questions.filter(q => questionIds.includes(q.questionId))
        : questions

    logger.info(`Ingesting ${targetQuestions.length} questions...`)

    for (let i = 0; i < targetQuestions.length; i++) {
        // Check for stop signal
        if (shouldStop(checkpoint.runId)) {
            logger.info(`Run ${checkpoint.runId} stopped by user`)
            throw new Error(`Run stopped by user. Resume with the same run ID.`)
        }

        const question = targetQuestions[i]
        const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`
        const sessions = benchmark.getHaystackSessions(question.questionId)

        const sessionsMetadata = sessions.map(s => ({
            sessionId: s.sessionId,
            date: s.metadata?.date as string | undefined,
            messageCount: s.messages.length,
        }))
        checkpointManager.updateSessions(checkpoint, question.questionId, sessionsMetadata)

        const status = checkpointManager.getPhaseStatus(checkpoint, question.questionId, "ingest")
        if (status === "completed") {
            logger.debug(`Skipping ${question.questionId} - already ingested`)
            continue
        }

        const startTime = Date.now()
        checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
            status: "in_progress",
            startedAt: new Date().toISOString(),
        })

        try {
            const completedSessions = checkpoint.questions[question.questionId].phases.ingest.completedSessions

            // Accumulate ingestResults from all sessions
            const combinedResult: IngestResult = { documentIds: [], taskIds: [] }

            for (const session of sessions) {
                if (completedSessions.includes(session.sessionId)) {
                    continue
                }

                const result = await provider.ingest([session], { containerTag })

                // Accumulate document IDs and task IDs
                combinedResult.documentIds.push(...result.documentIds)
                if (result.taskIds) {
                    combinedResult.taskIds!.push(...result.taskIds)
                }

                completedSessions.push(session.sessionId)
                checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
                    completedSessions,
                })

                const rateLimitMs = provider.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS
                if (rateLimitMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, rateLimitMs))
                }
            }

            // Clean up taskIds if empty
            if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
                delete combinedResult.taskIds
            }

            // Merge with any existing ingestResult (from resumed runs)
            const existingResult = checkpoint.questions[question.questionId].phases.ingest.ingestResult
            if (existingResult) {
                combinedResult.documentIds = [...existingResult.documentIds, ...combinedResult.documentIds]
                if (existingResult.taskIds || combinedResult.taskIds) {
                    combinedResult.taskIds = [...(existingResult.taskIds || []), ...(combinedResult.taskIds || [])]
                }
            }

            const durationMs = Date.now() - startTime
            checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
                status: "completed",
                ingestResult: combinedResult,
                completedAt: new Date().toISOString(),
                durationMs,
            })

            logger.progress(i + 1, targetQuestions.length, `Ingested ${question.questionId} (${durationMs}ms)`)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            checkpointManager.updatePhase(checkpoint, question.questionId, "ingest", {
                status: "failed",
                error,
            })
            logger.error(`Failed to ingest ${question.questionId}: ${error}`)
            throw new Error(`Ingest failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`)
        }
    }

    logger.success("Ingest phase complete")
}
