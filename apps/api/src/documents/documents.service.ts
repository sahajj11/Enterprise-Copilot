import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly uploadsDirectory = resolve(__dirname, '../../uploads');

  constructor(private readonly prisma: PrismaService) {}

  async upload(file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('A PDF file is required in the file field');
    }
    if (
      file.mimetype !== 'application/pdf' ||
      extname(file.originalname).toLowerCase() !== '.pdf' ||
      !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
    ) {
      throw new BadRequestException('Only PDF files with a valid PDF signature are allowed');
    }

    await mkdir(this.uploadsDirectory, { recursive: true });
    const filename = `${randomUUID()}.pdf`;
    const filePath = join(this.uploadsDirectory, filename);
    // Exclusive creation prevents overwriting an existing file, even on a collision.
    const handle = await open(filePath, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(file.buffer);
      } finally {
        await handle.close();
      }
      return await this.prisma.document.create({
        data: {
          filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          filePath,
        },
        select: { id: true, originalName: true, size: true, createdAt: true },
      });
    } catch (error) {
      try {
        await unlink(filePath);
      } catch (cleanupError) {
        this.logger.error(`Failed to remove upload ${filename}`, cleanupError);
      }
      throw error;
    }
  }
}
