// --- FILE: core/prompts/fileSummary.prompt.ts ---

/**
 * Generates the prompt for summarizing a single code file.
 * @param filePath The relative path of the file.
 * @param content The full content of the file.
 * @returns A formatted string ready to be sent to the OpenAI API.
 */
export function generateFileSummaryPrompt(filePath: string, content: string): string {
    return `Summarize the purpose of the following code file in one sentence. Be concise and focus on the file's primary role or responsibility.

File Path: ${filePath}

--- CODE START ---
${content}
--- CODE END ---

One-sentence summary:`;
}