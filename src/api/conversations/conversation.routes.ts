// --- FILE: api/conversations/conversation.routes.ts ---
import { Router } from 'express';
import * as conversationController from './conversation.controller';

// mergeParams is crucial for nested routes to access parent params like :projectId
const router = Router({ mergeParams: true });

router.post('/', conversationController.createConversation);
router.get('/', conversationController.listConversations);
router.get('/:conversationId', conversationController.getConversation);
router.post('/:conversationId/messages', conversationController.addMessageToConversation);

// NEW: Route to trigger the knowledge capture process for a conversation.
router.post('/:conversationId/capture-knowledge', conversationController.captureKnowledge);

export default router;