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
        // A heading of level 1 or 2 always starts a new chunk.
        if (node.type === 'heading' && (node.depth === 1 || node.depth === 2)) {
            // If we have a pending chunk, push it to the main array.
            if (currentChunk.length > 0) {
                chunks.push(toString({ type: 'root', children: currentChunk }));
            }
            // Start a new chunk with the current heading.
            currentChunk = [node];
        } else {
            // Otherwise, append the node to the current chunk.
            currentChunk.push(node);
        }
    });

    // Add the last remaining chunk.
    if (currentChunk.length > 0) {
        chunks.push(toString({ type: 'root', children: currentChunk }));
    }

    // If the document had no headings, the whole thing is one chunk.
    // In that case, we fall back to the paragraph chunker for better granularity.
    if (chunks.length === 1 && tree.children.some(node => node.type !== 'heading')) {
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