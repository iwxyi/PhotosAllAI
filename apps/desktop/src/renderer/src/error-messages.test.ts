import { describe, expect, it } from 'vitest';

import { analysisFailureMessage, fileOperationFailureMessage } from './error-messages';

describe('renderer error messages', () => {
  it('explains analysis failures with relevant recovery actions', () => {
    expect(analysisFailureMessage('PROVIDER_HTTP_401')).toContain('API 密钥');
    expect(analysisFailureMessage('PROVIDER_MODEL_UNAVAILABLE')).toContain('Model ID');
    expect(analysisFailureMessage('PROVIDER_JSON_MODE_UNSUPPORTED')).toContain('response_format');
    expect(analysisFailureMessage('PROVIDER_IMAGE_INPUT_UNSUPPORTED')).toContain('图片输入');
    expect(analysisFailureMessage('PROVIDER_HTTP_400')).toContain('模型 ID');
    expect(analysisFailureMessage('PROVIDER_HTTP_429')).toContain('额度');
    expect(analysisFailureMessage('PROVIDER_HTTP_503')).toContain('稍后重试');
    expect(analysisFailureMessage('PROVIDER_HTTP_504')).toContain('上游网关');
    expect(analysisFailureMessage('PROVIDER_CONNECTION_FAILED')).toContain('代理设置');
    expect(analysisFailureMessage('PROVIDER_RESPONSE_HTML')).toContain('/v1');
    expect(analysisFailureMessage('PROVIDER_RESPONSE_EMPTY')).toContain('空响应');
    expect(analysisFailureMessage('ANALYSIS_RESPONSE_SCHEMA_INVALID')).toContain('缺少字段');
    expect(analysisFailureMessage('ASSET_PREVIEW_NOT_FOUND')).toContain('原图是否存在');
  });

  it('does not invent a cause or expose raw error content for legacy failures', () => {
    expect(analysisFailureMessage(null)).toContain('未保存具体失败原因');
    expect(analysisFailureMessage('ANALYSIS_FAILED')).toContain('未保存具体失败原因');
    expect(analysisFailureMessage('/Users/private/api-key')).not.toContain('/Users/');
  });

  it('maps known operation failures without exposing internal codes', () => {
    expect(fileOperationFailureMessage('RECOVERY_DESTINATION_CONFLICT')).toBe('目标文件存在冲突');
    expect(fileOperationFailureMessage('/Users/private/catalog.sqlite')).toBe('操作失败，请检查图库状态后重试');
    expect(fileOperationFailureMessage(null)).toBe('操作失败，请检查图库状态后重试');
  });
});
