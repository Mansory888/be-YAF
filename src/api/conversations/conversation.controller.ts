// --- FILE: api/conversations/conversation.controller.ts ---
import { Request, Response, NextFunction } from 'express';
import * as conversationService from './conversation.service';
import * as qaService from '../projects/qa.service'; 

// streamResponse function (unchanged)
async function streamResponse(req: Request, res: Response, conversationId: number, projectId: number) {
    // ... (previous code)
    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let fullResponse = '';
    
    req.on('close', () => {
        console.log(`Client disconnected from conversation stream ${conversationId}.`);
        res.end();
    });

    try {
        const messages = await conversationService.getConversationMessages(conversationId);

        if (messages.length === 0) {
            throw new Error('Cannot stream response for an empty conversation.');
        }

        // The last message is the current question from the user
        const lastMessage = messages[messages.length - 1];
        const question = lastMessage.content;

        // The preceding messages form the history
        const history: qaService.ChatMessage[] = messages.slice(0, -1).map(m => ({
            role: m.role as ('user' | 'assistant'),
            content: m.content
        }));

        const { stream, sources } = await qaService.getAnswerStream(
            projectId,
            question,
            history // <-- Pass the history here
        );
        
        res.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);

        for await (const chunk of stream) {
            if (res.writableEnded) break;
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                fullResponse += content;
                res.write(`event: token\ndata: ${JSON.stringify({ token: content })}\n\n`);
            }
        }

        await conversationService.addAssistantMessage(conversationId, fullResponse, sources);

        if (!res.writableEnded) {
            res.write(`event: end\ndata: ${JSON.stringify({ message: "Stream finished" })}\n\n`);
            res.end();
        }
    } catch (streamError) {
        const errorMessage = streamError instanceof Error ? streamError.message : "An unknown error occurred during streaming.";
        console.error("Error during Q&A stream:", streamError);
        if (!res.writableEnded) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
            res.end();
        }
    }
}


// createConversation function (unchanged)
export async function createConversation(req: Request, res: Response, next: NextFunction) {
    // ... (previous code)
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const { first_message } = req.body;

        if (!first_message) {
            return res.status(400).json({ error: 'A "first_message" is required.' });
        }

        const conversation = await conversationService.createConversation(projectId, first_message);
        
        // MODIFIED: Pass req and projectId to the stream handler
        await streamResponse(req, res, conversation.id, projectId);

    } catch (error) {
        if (!res.headersSent) {
          next(error);
        } else {
          console.error("Error after headers sent in createConversation:", error);
          if (!res.writableEnded) {
            res.end();
          }
        }
    }
}

// addMessageToConversation function (unchanged)
export async function addMessageToConversation(req: Request, res: Response, next: NextFunction) {
    // ... (previous code)
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const conversationId = parseInt(req.params.conversationId, 10);
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'A "message" is required.' });
        }
        
        await conversationService.addUserMessage(conversationId, message);
        
        // MODIFIED: Pass req and projectId to the stream handler
        await streamResponse(req, res, conversationId, projectId);

    } catch (error) {
         if (!res.headersSent) {
          next(error);
        } else {
          console.error("Error after headers sent in addMessageToConversation:", error);
          if (!res.writableEnded) {
            res.end();
          }
        }
    }
}


// listConversations function (unchanged)
export async function listConversations(req: Request, res: Response, next: NextFunction) {
    // ... (previous code)
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const conversations = await conversationService.listConversations(projectId);
        res.json(conversations);
    } catch (error) {
        next(error);
    }
}

// getConversation function (unchanged)
export async function getConversation(req: Request, res: Response, next: NextFunction) {
    // ... (previous code)
    try {
        const conversationId = parseInt(req.params.conversationId, 10);
        const messages = await conversationService.getConversationMessages(conversationId);
        res.json(messages);
    } catch (error) {
        next(error);
    }
}

// NEW: Controller for capturing knowledge
export async function captureKnowledge(req: Request, res: Response, next: NextFunction) {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const conversationId = parseInt(req.params.conversationId, 10);

        const result = await conversationService.captureKnowledgeFromConversation(projectId, conversationId);

        if (!result) {
            return res.status(200).json({ message: 'No significant knowledge was found to capture.' });
        }

        res.status(201).json({ message: 'Knowledge captured successfully.', knowledgeNote: result });

    } catch (error) {
        next(error);
    }
}