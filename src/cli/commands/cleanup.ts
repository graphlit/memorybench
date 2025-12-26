import { CheckpointManager } from "../../orchestrator/checkpoint"
import { createProvider, getAvailableProviders } from "../../providers"
import { getProviderConfig } from "../../utils/config"
import type { ProviderName } from "../../types/provider"
import { logger } from "../../utils/logger"

interface CleanupArgs {
    runId: string
}

export function parseCleanupArgs(args: string[]): CleanupArgs | null {
    let runId: string | undefined

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "-r" || arg === "--run-id") {
            runId = args[++i]
        }
    }

    if (!runId) {
        return null
    }

    return { runId }
}

export async function cleanupCommand(args: string[]): Promise<void> {
    const parsed = parseCleanupArgs(args)

    if (!parsed) {
        console.log("Usage: bun run src/index.ts cleanup -r <runId>")
        console.log("")
        console.log("Deletes all provider data (collections, contents) for a completed run.")
        console.log("")
        console.log("Options:")
        console.log("  -r, --run-id   Run identifier")
        return
    }

    const checkpointManager = new CheckpointManager()
    
    if (!checkpointManager.exists(parsed.runId)) {
        console.log(`Run not found: ${parsed.runId}`)
        return
    }

    const checkpoint = checkpointManager.load(parsed.runId)
    if (!checkpoint) {
        console.log(`Failed to load checkpoint for run: ${parsed.runId}`)
        return
    }
    const providerName = checkpoint.provider as ProviderName

    if (!getAvailableProviders().includes(providerName)) {
        console.log(`Unknown provider: ${providerName}`)
        return
    }

    const provider = createProvider(providerName)
    await provider.initialize(getProviderConfig(providerName))

    const containerTags = Object.values(checkpoint.questions).map(q => q.containerTag)
    
    logger.info(`Cleaning up ${containerTags.length} collections for run ${parsed.runId}...`)

    let cleaned = 0
    let failed = 0

    for (const containerTag of containerTags) {
        try {
            await provider.clear(containerTag)
            cleaned++
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            logger.warn(`Failed to clear ${containerTag}: ${error}`)
            failed++
        }
    }

    logger.success(`Cleanup complete: ${cleaned} cleared, ${failed} failed`)
}
