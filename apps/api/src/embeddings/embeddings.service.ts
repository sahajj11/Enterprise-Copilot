import { Injectable, InternalServerErrorException, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { resolve } from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;
const BATCH_SIZE = 16;

@Injectable()
export class EmbeddingsService implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingsService.name);
  private initialization?: Promise<FeatureExtractionPipeline>;

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    // Native dynamic import works with the project's CommonJS/NodeNext output.
    const { pipeline } = await import('@huggingface/transformers');
    return pipeline('feature-extraction', EMBEDDING_MODEL, {
      device: 'cpu',
      dtype: 'fp32',
      cache_dir: resolve(__dirname, '../../.cache/models'),
    });
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    // Store the promise before awaiting so concurrent requests share one load.
    this.initialization ??= this.createPipeline().catch((error: unknown) => {
      this.initialization = undefined; // Allow a later request to retry a failed load.
      this.logger.error('Local embedding model initialization failed', error);
      throw new ServiceUnavailableException('Local embedding model is unavailable; retry later');
    });
    return this.initialization;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    try {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
        const batch = texts.slice(offset, offset + BATCH_SIZE);
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const rows = output.tolist() as number[][];
        if (rows.length !== batch.length || rows.some(row =>
          row.length !== EMBEDDING_DIMENSIONS || row.some(value => !Number.isFinite(value)))) {
          throw new Error('Unexpected embedding output dimensions or values');
        }
        vectors.push(...rows);
      }
      return vectors;
    } catch (error) {
      this.logger.error('Local embedding generation failed', error);
      throw new InternalServerErrorException('Unable to generate document embeddings');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.initialization) return;
    try {
      const extractor = await this.initialization;
      await extractor.dispose();
    } catch (error) {
      this.logger.error('Embedding model shutdown failed', error);
    }
  }
}
