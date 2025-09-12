// src/api/tasks/task.controller.ts
import { Request, Response, NextFunction } from 'express';
import * as taskService from './task.service';

export async function listTasks(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const status = req.query.status as string;
        const tasks = await taskService.getTasks(projectId, status);
        res.json(tasks);
    } catch (error) {
        next(error);
    }
}
// Add createTask, updateTask controllers here...