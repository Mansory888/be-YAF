// --- FILE: core/textChunker.ts ---
import { remark } from 'remark';
import { toString } from 'mdast-util-to-string';
import { Root } from 'mdast';

/**
 * A fallback chunker for plain text with no discernible structure.
 * It splits the content by paragraphs (double newlines).
 */
function chunkByParagraphs(content: string): string[] {
    return content
        .split(/\n\s*\n/)
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length > 20); // Filter out very short lines
}

/**
 * A sophisticated chunker that understands Markdown structure.
 * It groups content under headings to create semantically meaningful chunks.
 * For example, a "## Section Title" and all its following paragraphs and lists
 * will be combined into a single chunk.
 */
function chunkByHeadings(markdownContent: string): string[] {
    const tree = remark().parse(markdownContent) as Root;
    const chunks: string[] = [];
    let currentChunk: any[] = [];

    tree.children.forEach(node => {
        // A heading of level 1, 2, or 3 now starts a new chunk for better granularity.
        if (node.type === 'heading' && node.depth <= 3) {
            if (currentChunk.length > 0) {
                chunks.push(toString({ type: 'root', children: currentChunk }));
            }
            currentChunk = [node];
        } else {
            currentChunk.push(node);
        }
    });

    if (currentChunk.length > 0) {
        chunks.push(toString({ type: 'root', children: currentChunk }));
    }

    // --- NEW LOGGING: START ---
    console.log(`[textChunker] Initial chunking pass found ${chunks.length} potential chunks based on headings.`);
    // --- NEW LOGGING: END ---

    // If the document had no headings, the whole thing is one chunk.
    // In that case, we fall back to the paragraph chunker for better granularity.
    if (chunks.length === 1 && tree.children.some(node => node.type !== 'heading')) {
        // --- NEW LOGGING: START ---
        console.log('[textChunker] Only one heading-based chunk found. Falling back to paragraph-based chunking for better granularity.');
        // --- NEW LOGGING: END ---
        return chunkByParagraphs(chunks[0]);
    }
    
    return chunks.filter(chunk => chunk.trim().length > 0);
}

/**
 * The main text chunking function. It attempts to chunk by Markdown headings first,
 * and falls back to a simpler paragraph-based chunker if needed.
 * @param content The text or markdown content to be chunked.
 * @returns An array of string chunks.
 */
export function chunkText(content: string): string[] {
    // Trim initial/final whitespace which can affect parsing
    const trimmedContent = content.trim();
    if (!trimmedContent) {
        return [];
    }
    return chunkByHeadings(trimmedContent);
}