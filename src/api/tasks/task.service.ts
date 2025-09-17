// src/api/tasks/task.service.ts
import pool from '../../services/db';
import { getEmbedding } from '../../services/openai';
import pgvector from 'pgvector/pg';

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