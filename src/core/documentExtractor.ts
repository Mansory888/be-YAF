// --- FILE: core/documentExtractor.ts ---
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import TurndownService from 'turndown';

export class UnsupportedFileTypeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedFileTypeError';
    }
}

const turndownService = new TurndownService();

/**
 * Extracts clean text content from a file based on its extension.
 * Supports .txt, .md, .docx, and .pdf files.
 * @param filePath The path to the file on disk (the temporary file).
 * @param originalFilename The original name of the file, used to determine the extension.
 * @returns A promise that resolves with the extracted text content.
 * @throws {UnsupportedFileTypeError} if the file extension is not supported.
 */
export async function extractTextFromFile(filePath: string, originalFilename: string): Promise<string> {
    const extension = path.extname(originalFilename).toLowerCase();
    const buffer = fs.readFileSync(filePath);

    switch (extension) {
        case '.docx':
            // Mammoth only supports HTML conversion
            const htmlResult = await mammoth.convertToHtml({ buffer });
            // Convert HTML to Markdown with turndown
            return turndownService.turndown(htmlResult.value);

        case '.pdf':
            const data = await pdf(buffer);
            return data.text.replace(/(\s*\n){3,}/g, '\n\n').trim();

        case '.txt':
        case '.md':
        case '.json':
        case '.ts':
        case '.js':
        case '.py':
        case '.html':
        case '.css':
            return buffer.toString('utf-8');
            
        default:
            throw new UnsupportedFileTypeError(`File type "${extension}" is not supported for document ingestion.`);
    }
}
