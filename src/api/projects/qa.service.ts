// src/api/projects/qa.service.ts
import pool from '../../services/db';
import * as openAI from '../../services/openai';
import pgvector from 'pgvector/pg';
import { PoolClient } from 'pg';
import OpenAI from 'openai';

// NEW: Define a type for the sources we collect.
export interface Source {
    type: 'task' | 'commit' | 'document' | 'code' | 'knowledge'; // <-- Added 'knowledge'
    id: string | number;
    title: string;
}

// NEW: Define a type for message history, matching the one in openai.ts
export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}


// MODIFIED: The function signature is completely new.
export async function getAnswerStream(
    projectId: number, 
    latestQuestion: string, 
    history: ChatMessage[]
): Promise<{ stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>, sources: Source[] }> {
    let client: PoolClient | null = null;
    try {
        client = await pool.connect();
        const questionEmbedding = await openAI.getEmbedding(latestQuestion);
        let contextString = '';
        const sources: Source[] = [];

        // --- NEW: Search for relevant knowledge notes (past decisions) ---
        try {
            const { rows: relevantNotes } = await client.query(
                `SELECT id, note_summary FROM knowledge_notes WHERE project_id = $1 ORDER BY embedding <=> $2 LIMIT 2`,
                [projectId, pgvector.toSql(questionEmbedding)]
            );
            if (relevantNotes.length > 0) {
                contextString += "Relevant Past Decisions/Summaries:\n" + relevantNotes.map(n => `- ${n.note_summary}`).join('\n') + '\n\n';
                relevantNotes.forEach(n => sources.push({
                    type: 'knowledge',
                    id: n.id,
                    title: n.note_summary
                }));
            }
        } catch (error: any) {
             if (error.code === '42P01') {
                 console.warn('Warning: knowledge_notes table not found. Skipping knowledge search. Run migrations to enable this feature.');
            } else {
                throw error;
            }
        }

        // --- Existing context retrieval (unchanged logic) ---
        const { rows: relevantTasks } = await client.query(
            `SELECT task_number, title, status FROM tasks WHERE project_id = $1 ORDER BY embedding <=> $2 LIMIT 3`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        if (relevantTasks.length > 0) {
            contextString += "Relevant Tasks:\n" + relevantTasks.map(t => `- Task #${t.task_number} [${t.status.toUpperCase()}]: ${t.title}`).join('\n') + '\n\n';
            relevantTasks.forEach(t => sources.push({
                type: 'task',
                id: t.task_number,
                title: `#${t.task_number}: ${t.title}`
            }));
        }

        const { rows: relevantCommits } = await client.query(
            `SELECT commit_hash, message, author_name FROM commits WHERE project_id = $1 ORDER BY embedding <=> $2 LIMIT 3`,
            [projectId, pgvector.toSql(questionEmbedding)]
        );
        if (relevantCommits.length > 0) {
            contextString += "Relevant Commits:\n" + relevantCommits.map(c => `- Commit ${c.commit_hash.substring(0, 7)} by ${c.author_name}: ${c.message.split('\n')[0]}`).join('\n') + '\n\n';
            relevantCommits.forEach(c => sources.push({
                type: 'commit',
                id: c.commit_hash.substring(0, 7),
                title: `${c.commit_hash.substring(0, 7)}: ${c.message.split('\n')[0]}`
            }));
        }
        
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
                const uniqueDocs = [...new Map(relevantDocChunks.map(d => [d.file_name, d])).values()];
                uniqueDocs.forEach(d => sources.push({
                    type: 'document',
                    id: d.file_name,
                    title: d.file_name
                }));
            }
        } catch (error: any) {
            if (error.code === '42P01') {
                 console.warn('Warning: project_documents or document_chunks table not found. Skipping document search. Run migrations to enable this feature.');
            } else {
                throw error;
            }
        }

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
                
                const uniqueFilePaths = new Set(contextChunks.map(c => {
                    return relevantFiles.find(f => f.id === c.file_id)?.path;
                }).filter((p): p is string => !!p));

                uniqueFilePaths.forEach(filePath => sources.push({
                    type: 'code',
                    id: filePath,
                    title: filePath
                }));
            }
        }
        
        if (!contextString.trim() && history.length === 0) {
            throw new Error("No relevant context found for this question (no tasks, commits, code, or existing conversation).");
        }
        
        client.release();
        client = null;

        // --- NEW: Prompt construction with history ---
        const systemPrompt = `You are an expert AI software engineer. Answer the user's question based ONLY on the provided context and conversation history. Context may include past decisions, project documents, tasks, commits, and code snippets. Be concise, accurate, and provide code snippets in Markdown format when relevant. If the context and history are insufficient, state that clearly.`;

        const userMessageWithContext = `CONTEXT:\n${contextString}\n\nQUESTION:\n${latestQuestion}`;

        // Construct the full message payload for the OpenAI API
        const messages: openAI.ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userMessageWithContext }
        ];

        const stream = await openAI.getChatCompletionStream(messages);
        
        return { stream, sources };

    } finally {
        if (client) {
            client.release();
        }
    }
}