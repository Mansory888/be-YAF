// src/api/projects/project.routes.ts
import { Router } from 'express';
import * as projectController from './project.controller';
import taskRoutes from '../tasks/task.routes';

const router = Router();

router.get('/', projectController.listProjects);
router.post('/', projectController.addProject);
router.post('/:projectId/sync', projectController.syncProject);
router.post('/:projectId/ask', projectController.askQuestion);

// Mount task routes nested under projects
router.use('/:projectId/tasks', taskRoutes);

export default router;