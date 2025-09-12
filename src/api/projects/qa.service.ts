// src/api/projects/qa.service.ts
import { getDbClient } from '../../services/db';
import * as openAI from '../../services/openai';
import pgvector from 'pgvector/pg';

export async function getAnswerStream(projectId: number, question: string) {
    const client = await getDbClient();
    try {
        const questionEmbedding = await openAI.getEmbedding(question);

        const { rows: relevantFiles } = await client.query(
            `SELECT id, path FROM indexed_files WHERE project_id = $1 ORDER BY summary_embedding <=> $2 LIMIT 5`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        
        if (relevantFiles.length === 0) {
            throw new Error("No relevant files found for this question.");
        }

        const relevantFileIds = relevantFiles.map(f => f.id);
        const { rows: contextChunks } = await client.query(
            `SELECT file_id, content, chunk_name FROM code_chunks WHERE file_id = ANY($1::int[]) ORDER BY embedding <=> $2 LIMIT 10`,
            [relevantFileIds, pgvector.toSql(questionEmbedding)]
        );

        if (contextChunks.length === 0) {
            throw new Error("No relevant code chunks found for this question.");
        }

        const contextString = contextChunks.map(c => {
            const filePath = relevantFiles.find(f => f.id === c.file_id)?.path;
            return `--- FILE: ${filePath} (Chunk: ${c.chunk_name}) ---\n\n${c.content}`;
        }).join('\n\n');

        const systemPrompt = `You are an expert AI software engineer. Answer the user's question based ONLY on the provided code context. Be concise, accurate, and provide code snippets in Markdown format when relevant. If the context is insufficient, state that clearly.`;
        const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION:\n${question}`;
        
        return openAI.getChatCompletionStream(systemPrompt, userPrompt);

    } finally {
        await client.end();
    }
}