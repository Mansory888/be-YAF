// --- FILE: core/textChunker.ts ---

// A simple chunker for plain text or markdown files.
// It splits the content by paragraphs (double newlines) and filters out empty ones.
export function chunkText(content: string): string[] {
    return content
        .split(/\n\s*\n/) // Split by one or more empty lines
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length > 0);
}