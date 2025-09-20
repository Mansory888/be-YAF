// src/api/tasks/task.service.ts
import pool from '../../services/db';
import { getEmbedding } from '../../services/openai';
import pgvector from 'pgvector/pg';

// --- NEW: Define the structure for our context bundle ---
interface CodeSource {
    filePath: string;
    chunkName: string;
    content: string;
}

interface CommitSource {
    hash: string;
    author: string;
    date: string;
    message: string;
}

interface TaskSource {
    taskNumber: number;
    title: string;
    status: string;
}

interface DocumentSource {
    documentName: string;
    relevantChunk: string;
}

export interface ContextBundle {
    task: any; // The original task details
    relatedCode: CodeSource[];
    relatedCommits: CommitSource[];
    relatedTasks: TaskSource[];
    relatedDocuments: DocumentSource[];
}


export async function getTasks(projectId: number, status?: string) {
    const client = await pool.connect();
    try {
        let query = 'SELECT * FROM tasks WHERE project_id = $1';
        const params: any[] = [projectId];
        if (status) {
            query += ' AND status = $2';
            params.push(status);
        }
        query += ' ORDER BY task_number ASC';
        const { rows } = await client.query(query, params);
        return rows;
    } finally {
        client.release();
    }
}

export async function createTask(projectId: number, title: string, description?: string) {
    const client = await pool.connect();
    try {
        const contentToEmbed = `${title}${description ? `\n\n${description}` : ''}`;
        const titleEmbedding = await getEmbedding(contentToEmbed);
        const { rows } = await client.query(
            'INSERT INTO tasks (project_id, title, description, embedding) VALUES ($1, $2, $3, $4) RETURNING *',
            [projectId, title, description || null, pgvector.toSql(titleEmbedding)]
        );
        return rows[0];
    } catch (error) {
        console.error('Task creation failed. Ensure the `tasks` table has `description` and `embedding` columns.');
        throw error;
    }
    finally {
        client.release();
    }
}

interface TaskUpdates {
    title?: string;
    description?: string;
    status?: 'open' | 'in_progress' | 'done';
}

export async function updateTask(projectId: number, taskNumber: number, updates: TaskUpdates) {
    const client = await pool.connect();
    try {
        const { rows: existingTasks } = await client.query(
            'SELECT title, description FROM tasks WHERE project_id = $1 AND task_number = $2',
            [projectId, taskNumber]
        );

        if (existingTasks.length === 0) {
            throw new Error('Task not found');
        }

        const currentTask = existingTasks[0];
        const newTitle = updates.title || currentTask.title;
        const newDescription = updates.description || currentTask.description;

        const fieldsToUpdate = [];
        const values = [];
        let paramIndex = 1;

        if (updates.status) {
            if (!['open', 'in_progress', 'done'].includes(updates.status)) {
                throw new Error('Invalid task status');
            }
            fieldsToUpdate.push(`status = $${paramIndex++}`);
            values.push(updates.status);
        }
        if (updates.title) {
            fieldsToUpdate.push(`title = $${paramIndex++}`);
            values.push(updates.title);
        }
        if (updates.description) {
            fieldsToUpdate.push(`description = $${paramIndex++}`);
            values.push(updates.description);
        }

        if (updates.title || updates.description) {
            const contentToEmbed = `${newTitle}${newDescription ? `\n\n${newDescription}` : ''}`;
            const newEmbedding = await getEmbedding(contentToEmbed);
            fieldsToUpdate.push(`embedding = $${paramIndex++}`);
            values.push(pgvector.toSql(newEmbedding));
        }

        if (fieldsToUpdate.length === 0) {
            return currentTask;
        }

        fieldsToUpdate.push(`updated_at = NOW()`);
        
        values.push(projectId, taskNumber);

        const query = `UPDATE tasks SET ${fieldsToUpdate.join(', ')} WHERE project_id = $${paramIndex++} AND task_number = $${paramIndex++} RETURNING *`;
        
        const { rows } = await client.query(query, values);

        return rows[0];
    } finally {
        client.release();
    }
}

export async function deleteTask(projectId: number, taskNumber: number): Promise<void> {
    const client = await pool.connect();
    try {
        const result = await client.query(
            'DELETE FROM tasks WHERE project_id = $1 AND task_number = $2',
            [projectId, taskNumber]
        );

        if (result.rowCount === 0) {
            throw new Error('Task not found or does not belong to this project.');
        }
    } finally {
        client.release();
    }
}

// --- NEW: Function to assemble the context bundle ---
export async function getContextBundleForTask(projectId: number, taskNumber: number): Promise<ContextBundle> {
    const client = await pool.connect();
    try {
        // 1. Fetch the target task and its embedding
        const taskRes = await client.query('SELECT *, embedding::text FROM tasks WHERE project_id = $1 AND task_number = $2', [projectId, taskNumber]);
        if (taskRes.rows.length === 0) {
            throw new Error('Task not found');
        }
        const targetTask = taskRes.rows[0];
        const taskEmbedding = targetTask.embedding; // The embedding is already in the correct SQL format from the query

        // 2. Find related tasks (excluding the task itself)
        const relatedTasksRes = await client.query(
            `SELECT task_number, title, status FROM tasks 
             WHERE project_id = $1 AND task_number != $2 
             ORDER BY embedding <=> $3 LIMIT 3`,
            [projectId, taskNumber, taskEmbedding]
        );
        const relatedTasks: TaskSource[] = relatedTasksRes.rows;

        // 3. Find related commits
        const relatedCommitsRes = await client.query(
            `SELECT commit_hash, author_name, commit_date, message FROM commits
             WHERE project_id = $1 
             ORDER BY embedding <=> $2 LIMIT 5`,
            [projectId, taskEmbedding]
        );
        const relatedCommits: CommitSource[] = relatedCommitsRes.rows.map(c => ({
            hash: c.commit_hash.substring(0, 7),
            author: c.author_name,
            date: c.commit_date,
            message: c.message.split('\n')[0]
        }));
        
        // 4. Find related documents
        const relatedDocsRes = await client.query(
            `SELECT
               pd.file_name,
               dc.content
             FROM document_chunks dc
             JOIN project_documents pd ON dc.document_id = pd.id
             WHERE pd.project_id = $1
             ORDER BY dc.embedding <=> $2
             LIMIT 3`,
            [projectId, taskEmbedding]
        );
        const relatedDocuments: DocumentSource[] = relatedDocsRes.rows.map(d => ({
            documentName: d.file_name,
            relevantChunk: d.content
        }));

        // 5. Find related code (multi-step: find files, then find chunks in those files)
        const relevantFilesRes = await client.query(
            `SELECT id, path FROM indexed_files 
             WHERE project_id = $1 
             ORDER BY summary_embedding <=> $2 LIMIT 5`,
            [projectId, taskEmbedding]
        );
        
        let relatedCode: CodeSource[] = [];
        if (relevantFilesRes.rows.length > 0) {
            const relevantFileIds = relevantFilesRes.rows.map(f => f.id);
            const codeChunksRes = await client.query(
                `SELECT file_id, content, chunk_name FROM code_chunks 
                 WHERE file_id = ANY($1::int[]) 
                 ORDER BY embedding <=> $2 LIMIT 10`,
                [relevantFileIds, taskEmbedding]
            );
            
            relatedCode = codeChunksRes.rows.map(c => ({
                filePath: relevantFilesRes.rows.find(f => f.id === c.file_id)?.path || 'Unknown file',
                chunkName: c.chunk_name,
                content: c.content
            }));
        }

        // Assemble and return the final bundle
        return {
            task: targetTask,
            relatedCode,
            relatedCommits,
            relatedTasks,
            relatedDocuments,
        };
    } finally {
        client.release();
    }
}