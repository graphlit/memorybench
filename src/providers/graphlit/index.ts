import { Graphlit } from "graphlit-client"
import * as Types from "graphlit-client/dist/generated/graphql-types"
import type { Provider, ProviderConfig, IngestOptions, IngestResult, SearchOptions } from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { logger } from "../../utils/logger"
import { GRAPHLIT_PROMPTS } from "./prompts"

function formatSessionAsMarkdown(session: UnifiedSession): string {
    const lines: string[] = []

    lines.push(`## Session: ${session.sessionId}`)

    if (session.metadata?.date) {
        lines.push(`**Date**: ${session.metadata.date}`)
    }
    if (session.metadata?.formattedDate) {
        lines.push(`**Formatted Date**: ${session.metadata.formattedDate}`)
    }

    lines.push("")

    for (const message of session.messages) {
        const speaker = message.speaker || (message.role === "user" ? "User" : "Assistant")
        lines.push(`**${speaker}**: ${message.content}`)
        lines.push("")
    }

    return lines.join("\n")
}

export class GraphlitProvider implements Provider {
    name = "graphlit"
    prompts = GRAPHLIT_PROMPTS
    rateLimitMs = 0  // Graphlit handles rate limiting internally
    private client: Graphlit | null = null
    private collectionCache: Map<string, string> = new Map()
    private ingestedSessions: Set<string> = new Set()  // Track which sessions we've ingested (by sessionId)

    // Extract conversation ID from containerTag (e.g., "conv-26-q0-run-xxx" -> "conv-26-run-xxx")
    private getConversationContainerTag(containerTag: string): string {
        // containerTag format: "{questionId}-{runId}" where questionId is like "conv-26-q0"
        // We want: "{convId}-{runId}" where convId is like "conv-26"
        const parts = containerTag.split("-q")
        if (parts.length >= 2) {
            const convId = parts[0]  // "conv-26"
            const rest = parts[1].split("-").slice(1).join("-")  // "run-xxx" (skip the question number)
            return `${convId}-${rest}`
        }
        return containerTag  // Fallback to original if pattern doesn't match
    }

    async initialize(config: ProviderConfig): Promise<void> {
        const graphlitConfig = config.graphlit as {
            organizationId: string
            environmentId: string
            jwtSecret: string
            apiUri?: string
        } | undefined

        if (graphlitConfig) {
            this.client = new Graphlit(
                graphlitConfig.organizationId,
                graphlitConfig.environmentId,
                graphlitConfig.jwtSecret,
                undefined,
                undefined,
                graphlitConfig.apiUri,
            )
            logger.info(`Initialized Graphlit provider${graphlitConfig.apiUri ? ` (API: ${graphlitConfig.apiUri})` : ""}`)
        } else {
            // Fallback to env vars
            this.client = new Graphlit()
            logger.info(`Initialized Graphlit provider (using env vars)`)
        }
    }

    private async getOrCreateCollection(name: string): Promise<string> {
        if (!this.client) throw new Error("Provider not initialized")

        // Check cache first
        if (this.collectionCache.has(name)) {
            return this.collectionCache.get(name)!
        }

        // Try to find existing collection by name (exact match)
        const existing = await this.client.queryCollections({ name })
        if (existing.collections?.results && existing.collections.results.length > 0) {
            // Filter for exact name match (query returns fuzzy results)
            const exactMatch = existing.collections.results.find(c => c.name === name)
            if (exactMatch) {
                this.collectionCache.set(name, exactMatch.id)
                logger.debug(`Found existing collection: ${name}`)
                return exactMatch.id
            }
        }

        // Create new collection
        const result = await this.client.createCollection({ name })
        if (!result.createCollection?.id) {
            throw new Error(`Failed to create collection: ${name}`)
        }

        const id = result.createCollection.id
        this.collectionCache.set(name, id)
        logger.info(`Created collection: ${name}`)
        return id
    }

    async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
        if (!this.client) throw new Error("Provider not initialized")

        // Use conversation-level collection instead of question-level
        const convContainerTag = this.getConversationContainerTag(options.containerTag)
        const collectionId = await this.getOrCreateCollection(convContainerTag)

        const documentIds: string[] = []

        for (const session of sessions) {
            // Skip if we've already ingested this session
            if (this.ingestedSessions.has(session.sessionId)) {
                logger.debug(`Skipping session ${session.sessionId} - already ingested`)
                continue
            }

            const markdown = formatSessionAsMarkdown(session)

            const result = await this.client.ingestText(
                markdown,
                `Session ${session.sessionId}`,
                Types.TextTypes.Markdown,
                undefined,
                undefined,
                session.sessionId,
                false,  // async - poll in awaitIndexing
                undefined,
                [{ id: collectionId }],
            )

            if (result.ingestText?.id) {
                documentIds.push(result.ingestText.id)
                this.ingestedSessions.add(session.sessionId)
                logger.debug(`Ingested session ${session.sessionId}`)
            }
        }

        if (documentIds.length > 0) {
            logger.info(`Ingested ${documentIds.length} sessions into ${convContainerTag}`)
        }

        return { documentIds }
    }

    async awaitIndexing(result: IngestResult, _containerTag: string): Promise<void> {
        if (!this.client) throw new Error("Provider not initialized")
        
        const contentIds = result.documentIds
        if (contentIds.length === 0) return

        const pollInterval = 500
        const timeout = 300000
        const startTime = Date.now()

        // Poll until all contents are indexed
        for (const contentId of contentIds) {
            while (Date.now() - startTime < timeout) {
                try {
                    const status = await this.client.isContentDone(contentId)
                    if (status.isContentDone?.result) {
                        break
                    }
                } catch (e) {
                    const error = e instanceof Error ? e.message : String(e)
                    logger.error(`Failed to check content status for ${contentId}: ${error}`)
                    throw new Error(`Indexing check failed for content ${contentId}: ${error}`)
                }
                await new Promise(r => setTimeout(r, pollInterval))
            }
        }
        
        logger.debug(`Indexing complete for ${contentIds.length} documents`)
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        if (!this.client) throw new Error("Provider not initialized")

        // Use conversation-level collection
        const convContainerTag = this.getConversationContainerTag(options.containerTag)
        const collectionId = await this.getOrCreateCollection(convContainerTag)

        try {
            const response = await this.client.retrieveSources(
                query,
                { collections: [{ id: collectionId }] },
                undefined,
                {
                    type: Types.RetrievalStrategyTypes.Content,
                    contentLimit: options.limit || 10,
                },
                { serviceType: Types.RerankingModelServiceTypes.Cohere },
            )

            const results = response.retrieveSources?.results || []
            logger.debug(`Search for "${query.substring(0, 50)}..." returned ${results.length} results`)

            return results
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            logger.error(`Search failed: ${error}`)
            throw e
        }
    }

    async clear(containerTag: string): Promise<void> {
        if (!this.client) throw new Error("Provider not initialized")

        // Use conversation-level collection
        const convContainerTag = this.getConversationContainerTag(containerTag)

        try {
            // Get collection ID
            const collectionId = this.collectionCache.get(convContainerTag)
            if (!collectionId) {
                // Try to find by name (exact match)
                const existing = await this.client.queryCollections({ name: convContainerTag })
                const exactMatch = existing.collections?.results?.find(c => c.name === convContainerTag)
                if (!exactMatch) {
                    logger.debug(`No collection found to clear: ${convContainerTag}`)
                    return
                }

                // Delete all contents in the collection (set high limit to ensure all are deleted)
                await this.client.deleteAllContents(
                    { collections: [{ id: exactMatch.id }], limit: 10000 },
                    true,
                )

                // Delete the collection itself
                await this.client.deleteCollection(exactMatch.id)
                logger.info(`Cleared and deleted collection: ${convContainerTag}`)
            } else {
                // Delete all contents in the collection (set high limit to ensure all are deleted)
                await this.client.deleteAllContents(
                    { collections: [{ id: collectionId }], limit: 10000 },
                    true,
                )

                // Delete the collection itself
                await this.client.deleteCollection(collectionId)
                this.collectionCache.delete(convContainerTag)
                logger.info(`Cleared and deleted collection: ${convContainerTag}`)
            }
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            logger.warn(`Failed to clear collection ${convContainerTag}: ${error}`)
        }
    }
}

export default GraphlitProvider
