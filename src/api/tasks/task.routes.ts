// src/api/tasks/task.routes.ts
import { Router } from 'express';
import * as taskController from './task.controller';

const router = Router({ mergeParams: true }); // mergeParams is crucial for nested routes

router.get('/', taskController.listTasks);
router.post('/', taskController.createTask); 
router.put('/:taskNumber', taskController.updateTask); 
router.delete('/:taskNumber', taskController.deleteTask);

// --- NEW: Route to get the context bundle for a task ---
router.get('/:taskNumber/context-bundle', taskController.getTaskContextBundle);


export default router;