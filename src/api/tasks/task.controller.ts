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

// ADD THIS FUNCTION
export async function createTask(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { title } = req.body;
        if (!title) {
            return res.status(400).json({ error: 'A "title" is required.' });
        }
        const newTask = await taskService.createTask(projectId, title);
        res.status(201).json(newTask);
    } catch (error) {
        next(error);
    }
}

// ADD THIS FUNCTION
export async function updateTask(req: Request, res: Response, next: NextFunction) {
    try {
        const { projectId, taskNumber } = req.params;
        const { status } = req.body;
        
        const updatedTask = await taskService.updateTask(
            parseInt(projectId, 10),
            parseInt(taskNumber, 10),
            status
        );
        res.json(updatedTask);
    } catch (error) {
        next(error);
    }
}