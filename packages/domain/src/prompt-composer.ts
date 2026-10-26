import type { AnalysisResult } from '@photoallisai/contracts';

export type ComposePromptInput = {
  templateBody: string;
  analysis?: AnalysisResult | undefined;
  userInstruction: string;
  additionalPreservationRules?: readonly string[];
};

const variables = new Set([
  'analysis.summary',
  'analysis.generative_actions',
  'catalog.subjects',
  'user_instruction',
  'preservation_rules'
]);

export function composeGenerationPrompt(input: ComposePromptInput): string {
  const enabledActions = input.analysis?.generativeActions.filter((action) => action.enabled) ?? [];
  const preservationRules = new Set([
    ...enabledActions.flatMap((action) => action.preserve),
    ...(input.additionalPreservationRules ?? [])
  ]);
  const values: Record<string, string> = {
    'analysis.summary': input.analysis?.summary ?? '',
    'analysis.generative_actions': enabledActions
      .map((action, index) => `${index + 1}. ${action.instruction}（目标：${action.target}）`)
      .join('\n'),
    'catalog.subjects': input.analysis?.catalog.subjects.join('、') ?? '',
    user_instruction: input.userInstruction.trim(),
    preservation_rules: [...preservationRules].map((rule) => `- ${rule}`).join('\n')
  };

  const rendered = input.templateBody.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (match, name: string) => {
    if (!variables.has(name)) return match;
    return values[name] ?? '';
  });

  return rendered
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

