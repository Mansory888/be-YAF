// src/api/tasks/task.service.ts
import { getDbClient } from '../../services/db';

export async function getTasks(projectId: number, status?: string) {
    const client = await getDbClient();
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
        // Use client.release() if using a pool, or client.end() for single client
        await client.end();
    }
}

// ADD THIS FUNCTION
export async function createTask(projectId: number, title: string) {
    const client = await getDbClient();
    try {
        const { rows } = await client.query(
            'INSERT INTO tasks (project_id, title) VALUES ($1, $2) RETURNING *',
            [projectId, title]
        );
        return rows[0];
    } finally {
        await client.end();
    }
}

// ADD THIS FUNCTION
export async function updateTask(projectId: number, taskNumber: number, status: string) {
    const client = await getDbClient();
    try {
        // Ensure status is a valid one to prevent SQL injection with invalid enum values
        if (!['open', 'in_progress', 'done'].includes(status)) {
            throw new Error('Invalid task status');
        }

        const { rows } = await client.query(
            `UPDATE tasks SET status = $1, updated_at = NOW() 
             WHERE project_id = $2 AND task_number = $3 
             RETURNING *`,
            [status, projectId, taskNumber]
        );
        if (rows.length === 0) {
            throw new Error('Task not found');
        }
        return rows[0];
    } finally {
        await client.end();
    }
}