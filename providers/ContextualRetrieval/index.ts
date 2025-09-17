import type { BenchmarkRegistry, BenchmarkType } from "../../benchmarks";
import type { PreparedData, TemplateType } from "../_template";

export default {
	name: "ContextualRetrieval",
	addContext: async (data: PreparedData) => {
		// Process context with full type safety
		console.log(`Processing RAG context: ${data.context}`);
		console.log(`Metadata:`, data.metadata);
		// Add your RAG-specific context processing here
	},

	searchQuery: async (query: string) => {
		// RAG search implementation
		return [];
	},

	prepareProvider: <T extends BenchmarkType>(
		benchmarkType: T,
		data: BenchmarkRegistry[T][],
	): PreparedData[] => {
		switch (benchmarkType) {
			case "RAG": {
				const ragData = data as BenchmarkRegistry["RAG"][];
				return ragData.map((item) => ({
					context: `Question: ${item.question}\n\nRelevant Documents:\n${item.documents.map((d) => `- ${d.title || "Document"}: ${d.content}`).join("\n")}`,
					metadata: {
						benchmarkId: item.id,
						expectedAnswer: item.expected_answer,
						category: item.metadata.category,
						difficulty: item.metadata.difficulty,
						documentCount: item.documents.length,
						sourceDataset: item.metadata.source_dataset,
					},
				}));
			}

			default:
				throw new Error(
					`RAG provider does not support benchmark type: ${benchmarkType}`,
				);
		}
	},
} satisfies TemplateType;
