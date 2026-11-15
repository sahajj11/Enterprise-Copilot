import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post(':id/process')
  @HttpCode(200)
  process(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.documents.process(id);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.documents.upload(file);
  }
}
