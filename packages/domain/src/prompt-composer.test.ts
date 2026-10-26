import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@photoallisai/contracts';

import { composeGenerationPrompt } from './prompt-composer';

const analysis: AnalysisResult = {
  schemaVersion: '1.0',
  summary: '城市夜景人像，背景存在路人',
  report: '主体清晰。',
  quality: { overallScore: 78, issues: [] },
  adjustments: { global: [], local: [] },
  generativeActions: [
    {
      id: 'remove-people', type: 'remove_object', target: '背景路人', region: null,
      instruction: '移除背景路人并自然补全街道', preserve: ['主体身份', '主体服装'],
      risk: 'medium', confidence: 0.92, enabled: true
    },
    {
      id: 'replace-sky', type: 'replace_background', target: '天空', region: null,
      instruction: '更换天空', preserve: ['建筑轮廓'], risk: 'high', confidence: 0.5, enabled: false
    }
  ],
  catalog: {
    shortDescription: '夜景人像', longDescription: '', scenes: ['城市夜景'],
    subjects: ['单人', '半身人像'], objects: ['人物', '路人'], mood: ['都市'],
    colors: ['蓝色'], keywords: ['街拍'], ocrText: ''
  },
  generationRecommendation: { recommended: true, templateId: null, reason: '背景干扰' }
};

describe('generation prompt composer', () => {
  it('renders a user prompt and template without requiring visual analysis', () => {
    const prompt = composeGenerationPrompt({
      templateBody: '{{user_instruction}}\n{{analysis.summary}}\n{{analysis.generative_actions}}\n{{catalog.subjects}}',
      userInstruction: '转换为水彩风，保留人物身份'
    });
    expect(prompt).toBe('转换为水彩风，保留人物身份');
  });
  it('includes enabled AI actions and deduplicated preservation rules', () => {
    const prompt = composeGenerationPrompt({
      templateBody: '{{analysis.summary}}\n{{analysis.generative_actions}}\n主体：{{catalog.subjects}}\n{{user_instruction}}\n必须保留：\n{{preservation_rules}}',
      analysis,
      userInstruction: '保持自然皮肤纹理',
      additionalPreservationRules: ['主体身份', '原始文字']
    });
    expect(prompt).toContain('移除背景路人');
    expect(prompt).not.toContain('更换天空');
    expect(prompt.match(/主体身份/g)).toHaveLength(1);
    expect(prompt).toContain('单人、半身人像');
  });

  it('preserves unknown variables for explicit user correction', () => {
    const prompt = composeGenerationPrompt({
      templateBody: 'Known: {{analysis.summary}}\nUnknown: {{future.variable}}',
      analysis,
      userInstruction: ''
    });
    expect(prompt).toContain('{{future.variable}}');
  });
});

