import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { Provider } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import { CheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { shouldStop } from "../../server/runState"

export async function runSearchPhase(
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

    const resultsDir = checkpointManager.getResultsDir(checkpoint.runId)
    if (!existsSync(resultsDir)) {
        mkdirSync(resultsDir, { recursive: true })
    }

    logger.info(`Searching ${targetQuestions.length} questions...`)

    for (let i = 0; i < targetQuestions.length; i++) {
        // Check for stop signal
        if (shouldStop(checkpoint.runId)) {
            logger.info(`Run ${checkpoint.runId} stopped by user`)
            throw new Error(`Run stopped by user. Resume with the same run ID.`)
        }

        const question = targetQuestions[i]
        const containerTag = `${question.questionId}-${checkpoint.dataSourceRunId}`

        const status = checkpointManager.getPhaseStatus(checkpoint, question.questionId, "search")
        if (status === "completed") {
            logger.debug(`Skipping ${question.questionId} - already searched`)
            continue
        }

        const indexingStatus = checkpointManager.getPhaseStatus(checkpoint, question.questionId, "indexing")
        if (indexingStatus !== "completed") {
            logger.warn(`Skipping ${question.questionId} - not yet indexed`)
            continue
        }

        const startTime = Date.now()
        checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
            status: "in_progress",
            startedAt: new Date().toISOString(),
        })

        try {
            const results = await provider.search(question.question, {
                containerTag,
                limit: 15,
                threshold: 0.3,
            })

            const durationMs = Date.now() - startTime
            const resultFile = join(resultsDir, `${question.questionId}.json`)
            const resultData = {
                questionId: question.questionId,
                question: question.question,
                questionType: question.questionType,
                groundTruth: question.groundTruth,
                containerTag,
                timestamp: new Date().toISOString(),
                durationMs,
                results,
            }

            writeFileSync(resultFile, JSON.stringify(resultData, null, 2))

            checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
                status: "completed",
                resultFile,
                results,
                completedAt: new Date().toISOString(),
                durationMs,
            })

            logger.progress(i + 1, targetQuestions.length, `Searched ${question.questionId} (${durationMs}ms)`)
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            checkpointManager.updatePhase(checkpoint, question.questionId, "search", {
                status: "failed",
                error,
            })
            logger.error(`Failed to search ${question.questionId}: ${error}`)
            throw new Error(`Search failed at ${question.questionId}: ${error}. Fix the issue and resume with the same run ID.`)
        }
    }

    logger.success("Search phase complete")
}
