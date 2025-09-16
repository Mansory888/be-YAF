// --- FILE: core/prompts/taskGeneration.prompt.ts ---

/**
 * Generates the full prompt for the AI to analyze a git commit and create a structured task.
 * @param commitMessage The message from the git commit.
 * @param gitDiff The full text diff of the changes in the commit.
 * @returns A formatted string ready to be sent to the OpenAI API.
 */
export function generateTaskFromCommitPrompt(commitMessage: string, gitDiff: string): string {
    return `You are an expert software engineering project manager analyzing a git commit. Your goal is to generate a concise task title, a category, and a detailed description of the work.

**Instructions & Rules:**

1.  **Analyze**: Carefully review the commit message and the git diff to understand the full context of the work performed.
2.  **Output Format**: You MUST respond ONLY with a single JSON object. Do not include any explanatory text, markdown syntax, or anything outside of the JSON structure.
3.  **Trivial Commits**: If the diff is truly trivial (e.g., only a typo fix in a comment, a whitespace change), respond with the exact string "NULL" instead of a JSON object.
4.  **JSON Structure**: The JSON object must have three keys: "title", "category", and "description".

    *   **"title" field rules:**
        *   MUST start with an imperative verb (e.g., "Add", "Refactor", "Fix", "Update", "Implement").
        *   MUST be a single, concise line summarizing the work done.

    *   **"category" field rules:**
        *   MUST be one of the following exact strings: 'feature', 'fix', 'refactor', 'chore', 'docs', 'test'.

    *   **"description" field rules:**
        *   MUST be a brief, one or two-sentence summary of the changes.
        *   This summary SHOULD be followed by a short markdown bulleted list of the most important changes.
        *   Example: "This commit introduces a new queueing system to handle concurrent ingestion tasks. Key changes include:\n- Added 'p-queue' library.\n- Created a singleton queue service.\n- Wrapped the ingestion logic in the project controller."

**JSON Output Structure Example:**
\`\`\`json
{
  "title": "Implement a queue for ingestion tasks",
  "category": "feature",
  "description": "Introduces a job queue to manage concurrent project sync requests, preventing system crashes under load. Key changes include:\\n- Added 'p-queue' dependency.\\n- Created a global singleton queue service with a concurrency of 1.\\n- Modified the project controller to add ingestion jobs to the queue."
}
\`\`\`

---
**INPUT DATA**
---

**COMMIT MESSAGE:**
\`\`\`
${commitMessage}
\`\`\`

**GIT DIFF:**
\`\`\`diff
${gitDiff}
\`\`\`
`;
}