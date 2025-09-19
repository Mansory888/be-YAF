// --- FILE: api/conversations/conversation.service.ts ---
import pool from '../../services/db';
import * as openAI from '../../services/openai';
import pgvector from 'pgvector/pg';
import { Source } from '../projects/qa.service'; // Import the Source type

/**
 * Creates a new conversation and its first user message in the database.
 * @param projectId The ID of the project.
 * @param firstMessage The content of the user's first message.
 * @returns The newly created conversation object.
 */
export async function createConversation(projectId: number, firstMessage: string) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Generate a title from the first message
        const title = firstMessage.length > 80 ? firstMessage.substring(0, 77) + '...' : firstMessage;

        const convResult = await client.query(
            'INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING *',
            [projectId, title]
        );
        const conversation = convResult.rows[0];

        await client.query(
            `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
            [conversation.id, firstMessage]
        );

        await client.query('COMMIT');
        return conversation;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating conversation:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Adds a new user message to an existing conversation.
 * @param conversationId The ID of the conversation.
 * @param message The content of the user's message.
 */
export async function addUserMessage(conversationId: number, message: string) {
    const client = await pool.connect();
    try {
        await client.query(
            `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
            [conversationId, message]
        );
    } finally {
        client.release();
    }
}

/**
 * Adds an assistant's response to a conversation.
 * @param conversationId The ID of the conversation.
 * @param content The full text content of the assistant's reply.
 * @param sources The sources cited in the reply.
 */
export async function addAssistantMessage(conversationId: number, content: string, sources: any) {
    const client = await pool.connect();
    try {
        await client.query(
            `INSERT INTO conversation_messages (conversation_id, role, content, sources) VALUES ($1, 'assistant', $2, $3)`,
            [conversationId, content, JSON.stringify(sources)]
        );
        // Also update the conversation's updated_at timestamp
        await client.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
    } finally {
        client.release();
    }
}

/**
 * Lists all conversations for a given project.
 * @param projectId The ID of the project.
 */
export async function listConversations(projectId: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT id, title, updated_at FROM conversations WHERE project_id = $1 ORDER BY updated_at DESC',
            [projectId]
        );
        return rows;
    } finally {
        client.release();
    }
}

/**
 * Retrieves all messages for a single conversation.
 * @param conversationId The ID of the conversation.
 */
export async function getConversationMessages(conversationId: number) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(
            'SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at ASC',
            [conversationId]
        );
        return rows;
    } finally {
        client.release();
    }
}

// NEW: The core "learning" function.
export async function captureKnowledgeFromConversation(projectId: number, conversationId: number): Promise<{ id: number; summary: string } | null> {
    const client = await pool.connect();
    try {
        const messages = await getConversationMessages(conversationId);
        if (messages.length < 2) { // Need at least one user message and one assistant reply
            return null;
        }

        const transcript = messages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n---\n\n');

        const systemPrompt = `You are an AI assistant that distills key decisions and summaries from engineering conversations. Analyze the following transcript and extract the single most important decision, technical summary, or architectural choice. The summary MUST be a concise, one-sentence statement. If no clear decision was made or the conversation is trivial, respond with the exact string "NULL".

Example outputs:
- "Decision: The JWT expiration will be changed from 1 hour to 24 hours to improve user experience."
- "Conclusion: The ingestion pipeline performance issue is caused by a missing index on the 'commits' table."
- "Architectural Choice: A queueing system will be implemented using 'p-queue' to manage concurrent ingestion tasks."`;
        
        const userPrompt = `CONVERSATION TRANSCRIPT:\n\n${transcript}`;

        const summary = await openAI.getChatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]);

        if (!summary || summary.trim().toUpperCase() === 'NULL') {
            console.log(`AI determined no knowledge could be captured from conversation ${conversationId}.`);
            return null;
        }
        
        await client.query('BEGIN');
        
        const embedding = await openAI.getEmbedding(summary);

        const noteResult = await client.query(
            'INSERT INTO knowledge_notes (project_id, conversation_id, note_summary, embedding) VALUES ($1, $2, $3, $4) RETURNING id',
            [projectId, conversationId, summary, pgvector.toSql(embedding)]
        );
        const knowledgeNoteId = noteResult.rows[0].id;
        
        // --- Link the knowledge to its sources ---
        const allSources: Source[] = messages
            .filter(m => m.role === 'assistant' && m.sources)
            .flatMap(m => m.sources);
        
        const uniqueSources = Array.from(new Map(allSources.map(s => [`${s.type}:${s.id}`, s])).values());

        for (const source of uniqueSources) {
            if (source.type === 'code') {
                const { rows } = await client.query('SELECT id FROM indexed_files WHERE path = $1 AND project_id = $2', [source.id, projectId]);
                if (rows.length > 0) {
                    await client.query('INSERT INTO knowledge_note_links (knowledge_note_id, file_id) VALUES ($1, $2)', [knowledgeNoteId, rows[0].id]);
                }
            } else if (source.type === 'task') {
                 const { rows } = await client.query('SELECT id FROM tasks WHERE task_number = $1 AND project_id = $2', [source.id, projectId]);
                 if (rows.length > 0) {
                    await client.query('INSERT INTO knowledge_note_links (knowledge_note_id, task_id) VALUES ($1, $2)', [knowledgeNoteId, rows[0].id]);
                }
            }
            // Add linking for commits, documents, etc. in the same fashion if needed
        }

        await client.query('COMMIT');

        console.log(`Successfully captured knowledge note ${knowledgeNoteId} from conversation ${conversationId}.`);
        return { id: knowledgeNoteId, summary };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to capture knowledge from conversation ${conversationId}:`, error);
        throw error;
    } finally {
        client.release();
    }
}