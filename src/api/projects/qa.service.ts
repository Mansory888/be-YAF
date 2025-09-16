// src/api/projects/qa.service.ts
import { getDbClient } from '../../services/db';
import * as openAI from '../../services/openai';
import pgvector from 'pgvector/pg';

export async function getAnswerStream(projectId: number, question: string) {
    const client = await getDbClient();
    try {
        const questionEmbedding = await openAI.getEmbedding(question);
        let contextString = '';

        // --- Retrieve relevant tasks (no change) ---
        const { rows: relevantTasks } = await client.query(
            `SELECT task_number, title, status FROM tasks WHERE project_id = $1 ORDER BY embedding <=> $2 LIMIT 3`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        if (relevantTasks.length > 0) {
            contextString += "Relevant Tasks:\n" + relevantTasks.map(t => `- Task #${t.task_number} [${t.status.toUpperCase()}]: ${t.title}`).join('\n') + '\n\n';
        }

        // --- Retrieve relevant commits (no change) ---
        const { rows: relevantCommits } = await client.query(
            `SELECT commit_hash, message, author_name FROM commits WHERE project_id = $1 ORDER BY embedding <=> $2 LIMIT 3`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        if (relevantCommits.length > 0) {
            contextString += "Relevant Commits:\n" + relevantCommits.map(c => `- Commit ${c.commit_hash.substring(0, 7)} by ${c.author_name}: ${c.message.split('\n')[0]}`).join('\n') + '\n\n';
        }

        // --- MODIFIED: Retrieve relevant project documents with error handling ---
        try {
            const { rows: relevantDocChunks } = await client.query(
                `SELECT
                   pd.file_name,
                   dc.content
                 FROM document_chunks dc
                 JOIN project_documents pd ON dc.document_id = pd.id
                 WHERE pd.project_id = $1
                 ORDER BY dc.embedding <=> $2
                 LIMIT 3`,
                [projectId, pgvector.toSql(questionEmbedding)]
            );
            if (relevantDocChunks.length > 0) {
                contextString += "Relevant Project Documents:\n" + relevantDocChunks.map(d => `--- FROM DOCUMENT: ${d.file_name} ---\n\n${d.content}`).join('\n\n') + '\n\n';
            }
        } catch (error: any) {
            // If the table doesn't exist, this query will fail. We catch the error
            // and log a warning instead of crashing the application.
            if (error.code === '42P01') { // 42P01 is the PostgreSQL code for "undefined_table"
                 console.warn('Warning: project_documents or document_chunks table not found. Skipping document search. Run migrations to enable this feature.');
            } else {
                // For any other unexpected error, we still throw it.
                throw error;
            }
        }

        // --- Retrieve relevant files and code chunks (no change) ---
        const { rows: relevantFiles } = await client.query(
            `SELECT id, path FROM indexed_files WHERE project_id = $1 ORDER BY summary_embedding <=> $2 LIMIT 5`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        
        if (relevantFiles.length > 0) {
            const relevantFileIds = relevantFiles.map(f => f.id);
            const { rows: contextChunks } = await client.query(
                `SELECT file_id, content, chunk_name FROM code_chunks WHERE file_id = ANY($1::int[]) ORDER BY embedding <=> $2 LIMIT 10`,
                [relevantFileIds, pgvector.toSql(questionEmbedding)]
            );
            
            if (contextChunks.length > 0) {
                 const chunkContext = contextChunks.map(c => {
                    const filePath = relevantFiles.find(f => f.id === c.file_id)?.path;
                    return `--- FILE: ${filePath} (Chunk: ${c.chunk_name}) ---\n\n${c.content}`;
                }).join('\n\n');
                contextString += "Relevant Code Snippets:\n" + chunkContext;
            }
        }
        
        if (!contextString.trim()) {
            throw new Error("No relevant context found for this question (no tasks, commits, or code).");
        }

        const systemPrompt = `You are an expert AI software engineer. Answer the user's question based ONLY on the provided context, which may include project documents, tasks, commits, and code snippets. Be concise, accurate, and provide code snippets in Markdown format when relevant. If the context is insufficient, state that clearly.`;
        const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION:\n${question}`;
        
        return openAI.getChatCompletionStream(systemPrompt, userPrompt);

    } finally {
        await client.end();
    }
}