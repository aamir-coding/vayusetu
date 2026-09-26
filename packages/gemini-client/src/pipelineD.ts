import { z } from 'zod';
import type { PipelineFunctionDeclaration } from './functionCalling.js';
import { PIPELINE_A_SYSTEM_INSTRUCTION } from './pipelineA.js';

/**
 * Pipeline D -- Conversational Clarification (AI_PIPELINES.md).
 *
 * Runs only when Pipeline A came back `indeterminate` below the confidence
 * threshold. The model gets Pipeline A's instruction plus the addendum
 * below and TWO allowed functions: the unchanged record_air_quality_assessment
 * (if the evidence is now enough) or ask_clarifying_question (exactly one
 * short question). Capped at MAX_CLARIFICATION_TURNS; after that -- or if
 * the citizen never answers -- the report stays "recorded as unclassified,
 * will be reviewed" (needsHumanReview).
 */
export const MAX_CLARIFICATION_TURNS = 2;

export const PIPELINE_D_ADDENDUM = `

Clarification mode: your previous assessment of this report was
indeterminate. If the photo(s), transcript and any clarification answers
now let you classify it, call record_air_quality_assessment. Otherwise call
ask_clarifying_question with ONE short, friendly question (at most 25
words) that a non-expert can act on -- for example asking them to point the
camera further away, or whether the smoke comes from a chimney or a field.
Write the question in the language given by advisoryLanguage. Never ask
for personal information.`;

export const PIPELINE_D_SYSTEM_INSTRUCTION = PIPELINE_A_SYSTEM_INSTRUCTION + PIPELINE_D_ADDENDUM;

export const ASK_CLARIFYING_QUESTION: PipelineFunctionDeclaration = {
  name: 'ask_clarifying_question',
  description: 'Asks the citizen one short follow-up question when the report cannot yet be classified.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      language: { type: 'string', description: 'BCP-47 tag, same as advisoryLanguage' },
    },
    required: ['question', 'language'],
  },
};

export const AskClarifyingQuestionSchema = z.object({
  question: z
    .string()
    .min(3)
    .max(240)
    .refine((q) => q.trim().split(/\s+/).length <= 40, 'question too long'),
  language: z.string().min(2),
});
export type AskClarifyingQuestion = z.infer<typeof AskClarifyingQuestionSchema>;
