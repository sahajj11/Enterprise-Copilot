import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { FormatError, InvalidPDFException, PasswordException, PDFParse } from 'pdf-parse';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly uploadsDirectory = resolve(__dirname, '../../uploads');

  constructor(private readonly prisma: PrismaService) {}

  async process(id: string) {
    const document = await this.prisma.document.findUnique({ where: { id } });
    if (!document) {
      throw new NotFoundException('Document not found');
    }

    let data: Buffer;
    try {
      data = await readFile(document.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new NotFoundException('Document file not found');
      }
      this.logger.error(`Failed to read document ${id}`, error);
      throw new InternalServerErrorException('Unable to read document file');
    }

    let parser: PDFParse | undefined;
    try {
      // Copy into a transferable Uint8Array for PDF.js worker compatibility.
      parser = new PDFParse({ data: new Uint8Array(data) });
      const result = await parser.getText({ pageJoiner: '\n\n' });
      const text = result.text.trim();
      return {
        documentId: document.id,
        pageCount: result.total,
        text,
        characterCount: text.length,
      };
    } catch (error) {
      if (error instanceof PasswordException) {
        throw new UnprocessableEntityException('Password-protected PDFs are not supported');
      }
      if (error instanceof InvalidPDFException || error instanceof FormatError) {
        throw new UnprocessableEntityException('The document is not a valid readable PDF');
      }
      this.logger.error(`Failed to extract document ${id}`, error);
      throw new InternalServerErrorException('Unable to extract PDF text');
    } finally {
      if (parser) {
        try {
          await parser.destroy();
        } catch (error) {
          // Preserve the extraction result or original error if cleanup fails.
          this.logger.error(`Failed to release PDF parser for document ${id}`, error);
        }
      }
    }
  }

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
