import { CheckpointManager } from "../../orchestrator/checkpoint"
import { createProvider, getAvailableProviders } from "../../providers"
import { getProviderConfig } from "../../utils/config"
import type { ProviderName } from "../../types/provider"
import { logger } from "../../utils/logger"

interface CleanupArgs {
    runId?: string
    all?: boolean
}

export function parseCleanupArgs(args: string[]): CleanupArgs | null {
    let runId: string | undefined
    let all = false

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "-r" || arg === "--run-id") {
            runId = args[++i]
        } else if (arg === "--all") {
            all = true
        }
    }

    if (!runId && !all) {
        return null
    }

    return { runId, all }
}

export async function cleanupCommand(args: string[]): Promise<void> {
    const parsed = parseCleanupArgs(args)

    if (!parsed) {
        console.log("Usage: bun run src/index.ts cleanup -r <runId>")
        console.log("       bun run src/index.ts cleanup --all")
        console.log("")
        console.log("Deletes all provider data (collections, contents) for a completed run.")
        console.log("")
        console.log("Options:")
        console.log("  -r, --run-id   Run identifier")
        console.log("  --all          Clean up ALL runs")
        return
    }

    const checkpointManager = new CheckpointManager()

    // Get list of runs to clean
    const runIds: string[] = []
    if (parsed.all) {
        const allRuns = checkpointManager.listRuns()
        runIds.push(...allRuns)
        if (runIds.length === 0) {
            console.log("No runs found to clean up.")
            return
        }
        logger.info(`Found ${runIds.length} runs to clean up`)
    } else if (parsed.runId) {
        if (!checkpointManager.exists(parsed.runId)) {
            console.log(`Run not found: ${parsed.runId}`)
            return
        }
        runIds.push(parsed.runId)
    }

    // Group runs by provider
    const runsByProvider: Map<ProviderName, string[]> = new Map()
    for (const runId of runIds) {
        const checkpoint = checkpointManager.load(runId)
        if (!checkpoint) {
            logger.warn(`Failed to load checkpoint for run: ${runId}`)
            continue
        }
        const providerName = checkpoint.provider as ProviderName
        if (!runsByProvider.has(providerName)) {
            runsByProvider.set(providerName, [])
        }
        runsByProvider.get(providerName)!.push(runId)
    }

    let totalCleaned = 0
    let totalFailed = 0

    // Clean up each provider's runs
    for (const [providerName, providerRunIds] of runsByProvider) {
        if (!getAvailableProviders().includes(providerName)) {
            logger.warn(`Unknown provider: ${providerName}, skipping ${providerRunIds.length} runs`)
            continue
        }

        const provider = createProvider(providerName)
        await provider.initialize(getProviderConfig(providerName))

        for (const runId of providerRunIds) {
            const checkpoint = checkpointManager.load(runId)!
            const containerTags = [...new Set(Object.values(checkpoint.questions).map(q => q.containerTag))]
            
            logger.info(`Cleaning up ${containerTags.length} collections for run ${runId} (${providerName})...`)

            for (const containerTag of containerTags) {
                try {
                    await provider.clear(containerTag)
                    totalCleaned++
                } catch (e) {
                    const error = e instanceof Error ? e.message : String(e)
                    logger.warn(`Failed to clear ${containerTag}: ${error}`)
                    totalFailed++
                }
            }
        }
    }

    // Delete local run folders when using --all
    if (parsed.all) {
        logger.info(`Deleting ${runIds.length} local run folders...`)
        for (const runId of runIds) {
            checkpointManager.delete(runId)
        }
    }

    logger.success(`Cleanup complete: ${totalCleaned} provider collections cleared, ${totalFailed} failed`)
}
