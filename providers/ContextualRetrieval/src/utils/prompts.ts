// prompt to generate an overall document summary for contextual retrieval
export const createDocumentSummaryPrompt = (document: string) => {
	return `Given the following document, generate a summary that captures the main points and key information.
  Make sure to include key figures, date-time / temporal data, and significant details relevant to each part of the document.

  <document>
  ${document}
  </document>`;
};

// prompt to enhance chunk with contextual retrieval (document summary)
export const createEnhanceChunkPrompt = (
	documentSummary: string,
	chunk: string,
) => {
	return `Given the document summary, enhance the chunk summary with relevant information.
  Make sure to include key figures, date-time / temporal data, and significant details relevant to each part of the document.

  <document_summary>
  ${documentSummary}
  </document_summary>

  <chunk>
  ${chunk}
  </chunk>`;
};

// prompt to generate questions from a chunk
export const createGenerateQuestionsPrompt = (chunk: string, numberOfQuestionsPerChunk: number) => {
	return `Given the following chunk, generate a list of questions that can be answered using the information in the chunk.
  Make sure to include questions that cover key figures, date-time / temporal data, and significant details relevant to each part of the chunk.

  Example: 
  Given a chunk "04/22/2005 3:00 PM: Soham was born in Amravati, India."
 
  You may generate specific questions like:
  - When was Soham born?
  - Where was Soham born?
  
  Note: the above example is a illustration of how to generate questions from a chunk. Actual chunks will be much larger.
  
  In general, generate about ${numberOfQuestionsPerChunk} questions for the chunk.

  <chunk>
  ${chunk}
  </chunk>`;
};


