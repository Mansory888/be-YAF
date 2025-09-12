// src/api/tasks/task.routes.ts
import { Router } from 'express';
import * as taskController from './task.controller';

const router = Router({ mergeParams: true }); // mergeParams is crucial for nested routes

router.get('/', taskController.listTasks);
// router.post('/', taskController.createTask);
// router.put('/:taskNumber', taskController.updateTask);

export default router;