// --- FILE: api/tasks/task.controller.ts ---

// src/api/tasks/task.controller.ts
import { Request, Response, NextFunction } from 'express';
import * as taskService from './task.service';

export async function listTasks(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const status = req.query.status as string | undefined; // Allow undefined
        const tasks = await taskService.getTasks(projectId, status);
        res.json(tasks);
    } catch (error) {
        next(error);
    }
}

// MODIFIED: Handle 'description' field from the body
export async function createTask(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { title, description } = req.body; // <-- Get description here
        if (!title) {
            return res.status(400).json({ error: 'A "title" is required.' });
        }
        const newTask = await taskService.createTask(projectId, title, description); // <-- Pass it here
        res.status(201).json(newTask);
    } catch (error) {
        next(error);
    }
}

// MODIFIED: Handle multiple fields for update
export async function updateTask(req: Request, res: Response, next: NextFunction) {
    try {
        const { projectId, taskNumber } = req.params;
        const { title, description, status } = req.body; // <-- Get all potential updates
        
        const updatedTask = await taskService.updateTask(
            parseInt(projectId, 10),
            parseInt(taskNumber, 10),
            { title, description, status } // <-- Pass as an object
        );
        res.json(updatedTask);
    } catch (error) {
        next(error);
    }
}

export async function deleteTask(req: Request, res: Response, next: NextFunction) {
    try {
        const { projectId, taskNumber } = req.params;
        await taskService.deleteTask(
            parseInt(projectId, 10),
            parseInt(taskNumber, 10)
        );
        // 204 No Content is the standard successful response for a DELETE request
        res.status(204).send();
    } catch (error) {
        next(error);
    }
}