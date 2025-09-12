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
        await client.end();
    }
}
// Add createTask, updateTask services here...