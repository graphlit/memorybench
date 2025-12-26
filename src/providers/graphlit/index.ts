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
    private client: Graphlit | null = null
    private collectionCache: Map<string, string> = new Map()
    private firstIngestPerContainer: Set<string> = new Set()

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

    private async getOrCreateCollection(name: string, clearExisting: boolean = false): Promise<string> {
        if (!this.client) throw new Error("Provider not initialized")

        // Check cache first (already processed this run)
        if (this.collectionCache.has(name)) {
            return this.collectionCache.get(name)!
        }

        // Try to find existing collection by name
        const existing = await this.client.queryCollections({ name })
        if (existing.collections?.results && existing.collections.results.length > 0) {
            const id = existing.collections.results[0]!.id
            
            if (clearExisting) {
                // Clear old contents before re-ingesting
                logger.info(`Clearing existing data in collection: ${name}`)
                await this.client.deleteAllContents(
                    { collections: [{ id }], limit: 10000 },
                    true,
                )
                logger.info(`Cleared collection, ready for fresh ingestion`)
            } else {
                logger.info(`Reusing existing collection: ${name} (data already ingested)`)
            }
            
            this.collectionCache.set(name, id)
            return id
        }

        // Create new collection
        const result = await this.client.createCollection({ name })
        if (!result.createCollection?.id) {
            throw new Error(`Failed to create collection: ${name}`)
        }

        const id = result.createCollection.id
        this.collectionCache.set(name, id)
        logger.info(`Created new collection: ${name}`)
        return id
    }

    async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
        if (!this.client) throw new Error("Provider not initialized")

        // Check if this is the first ingest call for this containerTag
        const isFirstIngest = !this.firstIngestPerContainer.has(options.containerTag)
        if (isFirstIngest) {
            this.firstIngestPerContainer.add(options.containerTag)
        }
        
        // Ensure collection exists, clear existing contents on first ingest
        const collectionId = await this.getOrCreateCollection(options.containerTag, isFirstIngest)

        const documentIds: string[] = []

        for (const session of sessions) {
            const markdown = formatSessionAsMarkdown(session)

            const result = await this.client.ingestText(
                markdown,
                `Session ${session.sessionId}`,
                Types.TextTypes.Markdown,
                undefined,
                undefined,
                session.sessionId,
                true,  // isSynchronous - wait for indexing
                undefined,
                [{ id: collectionId }],
            )

            if (result.ingestText?.id) {
                documentIds.push(result.ingestText.id)
                logger.debug(`Ingested session ${session.sessionId}`)
            }
        }

        return { documentIds }
    }

    async awaitIndexing(_result: IngestResult, _containerTag: string): Promise<void> {
        // No-op: isSynchronous=true in ingestText handles indexing
    }

    async search(query: string, options: SearchOptions): Promise<unknown[]> {
        if (!this.client) throw new Error("Provider not initialized")

        // Get collection ID (should exist from ingest phase)
        const collectionId = await this.getOrCreateCollection(options.containerTag)

        try {
            const response = await this.client.retrieveSources(
                query,
                { collections: [{ id: collectionId }] },
                undefined,
                {
                    type: Types.RetrievalStrategyTypes.Section,
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

        try {
            // Get collection ID
            const collectionId = this.collectionCache.get(containerTag)
            if (!collectionId) {
                // Try to find by name
                const existing = await this.client.queryCollections({ name: containerTag })
                if (!existing.collections?.results || existing.collections.results.length === 0) {
                    logger.debug(`No collection found to clear: ${containerTag}`)
                    return
                }
                const id = existing.collections.results[0]!.id

                // Delete all contents in the collection (set high limit to ensure all are deleted)
                await this.client.deleteAllContents(
                    { collections: [{ id }], limit: 10000 },
                    true,
                )

                // Delete the collection itself
                await this.client.deleteCollection(id)
                logger.info(`Cleared and deleted collection: ${containerTag}`)
            } else {
                // Delete all contents in the collection (set high limit to ensure all are deleted)
                await this.client.deleteAllContents(
                    { collections: [{ id: collectionId }], limit: 10000 },
                    true,
                )

                // Delete the collection itself
                await this.client.deleteCollection(collectionId)
                this.collectionCache.delete(containerTag)
                logger.info(`Cleared and deleted collection: ${containerTag}`)
            }
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e)
            logger.warn(`Failed to clear collection ${containerTag}: ${error}`)
        }
    }
}

export default GraphlitProvider
