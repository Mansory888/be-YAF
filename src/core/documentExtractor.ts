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

// MODIFIED: Create a Turndown instance and add a custom rule.
const turndownService = new TurndownService();

// This new rule identifies paragraphs that ONLY contain bold text and treats them as H2 headings.
// This is a robust way to handle documents where users bold text for headers instead of using proper styles.
turndownService.addRule('strongIsHeading', {
    filter: (node, options) => {
        // Check if the node is a paragraph
        if (node.nodeName !== 'P') {
            return false;
        }
        // Check if it has exactly one child
        if (node.childNodes.length !== 1) {
            return false;
        }
        const child = node.firstChild!;
        // Check if that single child is a <strong> tag
        if (child.nodeName !== 'STRONG') {
            return false;
        }
        // Optional: Check if the heading text is reasonably short
        return (child.textContent || '').length < 200;
    },
    replacement: (content) => {
        // Replace it with a markdown H2 heading
        return `## ${content}\n\n`;
    }
});


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
            // The styleMap is a good fallback, but our new Turndown rule is more robust for this case.
            const options = {
                styleMap: [
                    "p[style-name='Heading 1'] => h1:fresh",
                    "p[style-name='Heading 2'] => h2:fresh",
                    "p[style-name='Heading 3'] => h3:fresh",
                    "p[style-name='heading 1'] => h1:fresh",
                    "p[style-name='heading 2'] => h2:fresh",
                    "p[style-name='heading 3'] => h3:fresh",
                ]
            };
            const htmlResult = await mammoth.convertToHtml({ buffer }, options);
            // Use our customized turndown service to convert HTML to Markdown
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