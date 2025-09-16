// src/api/projects/project.routes.ts
import { Router } from 'express';
import * as projectController from './project.controller';
import taskRoutes from '../tasks/task.routes';

const router = Router();

router.get('/', projectController.listProjects);
router.post('/', projectController.addProject);

// MODIFIED: This is now a GET request to establish an SSE connection for logs
router.get('/:projectId/sync-stream', projectController.streamIngestionLogs);

router.post('/:projectId/ask', projectController.askQuestion);

// Mount task routes nested under projects
router.use('/:projectId/tasks', taskRoutes);

export default router;