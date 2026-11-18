import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;

export async function chunkText(text: string) {
  if (!text.trim()) return [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
  const chunks = await splitter.splitText(text);
  return chunks.map((text, index) => ({ index, text, characterCount: text.length }));
}
