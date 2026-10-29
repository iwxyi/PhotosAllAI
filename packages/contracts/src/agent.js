import { z } from 'zod';
export const agentAskChoiceSchema = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160), description: z.string().max(400).optional() }).strict();
export const agentAskInputSchema = z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(160), placeholder: z.string().max(240).optional(), required: z.boolean().default(true) }).strict();
export const agentAskInteractionSchema = z.object({ choices: z.array(agentAskChoiceSchema).max(8).default([]), inputs: z.array(agentAskInputSchema).max(8).default([]) }).strict();
export const agentActionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('tool'), text: z.string().min(1).max(4000), name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ type: z.literal('ask'), text: z.string().min(1).max(4000), interaction: agentAskInteractionSchema.optional() }).strict(),
    z.object({ type: z.literal('finish'), text: z.string().min(1).max(4000) }).strict()
]);
export const agentMessageSchema = z.object({
    id: z.string().uuid(), role: z.enum(['user', 'assistant', 'tool']), text: z.string(),
    detail: z.string().optional(), createdAt: z.number(), callId: z.string().uuid().optional(), assetIds: z.array(z.string()).max(500).optional(), interaction: agentAskInteractionSchema.optional()
});
export const agentCallSchema = z.object({
    requestId: z.string().uuid().optional(),
    id: z.string().uuid(), name: z.string(), arguments: z.record(z.string(), z.unknown()),
    status: z.enum(['approval', 'executing', 'waiting', 'done', 'error', 'rejected', 'uncertain']),
    taskIds: z.array(z.string().uuid()), wakeAt: z.number().nullable(), result: z.string().nullable(),
    approved: z.boolean().default(false), resultIds: z.array(z.string().uuid()).default([])
});
export const agentSessionSchema = z.object({
    source: z.enum(['internal', 'external']).optional(), externalOwner: z.string().optional(),
    id: z.string().uuid(), title: z.string(), assetIds: z.array(z.string()),
    status: z.enum(['idle', 'running', 'awaiting_input', 'awaiting_approval', 'waiting', 'paused', 'completed', 'failed', 'canceled']),
    messages: z.array(agentMessageSchema), calls: z.array(agentCallSchema),
    requestCallStart: z.number().int().min(0).optional(),
    requestMessageStart: z.number().int().min(0).optional(),
    turns: z.number(), outputs: z.number(), createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable()
});
export const createAgentSessionSchema = z.object({ assetIds: z.array(z.string().min(1)).max(500) }).strict();
export const agentSessionIdSchema = z.string().uuid();
export const agentSendSchema = z.object({ sessionId: agentSessionIdSchema, text: z.string().trim().min(1).max(20000), assetIds: z.array(z.string().min(1)).max(500).optional() }).strict();
export const agentControlSchema = z.object({ sessionId: agentSessionIdSchema, action: z.enum(['pause', 'resume', 'cancel', 'approve', 'reject']), callId: z.string().uuid().optional() }).strict();
export const mcpStatusSchema = z.object({ enabled: z.boolean(), url: z.string().nullable(), token: z.string().nullable(), tools: z.number() });
