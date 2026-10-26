export function generationFailureMessage(code: string | null | undefined): string {
  switch (code) {
    case 'PROVIDER_HTTP_400': return '生图请求被拒绝，请检查模型 ID、接口类型及提示词。';
    case 'PROVIDER_HTTP_403': return '生图请求被拒绝，请检查权限或调整提示词与参考图。';
    case 'PROVIDER_IMAGE_MISSING': return '接口没有返回生成图片，请重试或检查接口兼容性。';
    case 'GENERATED_IMAGE_FORMAT_UNSUPPORTED': return '返回的文件不是支持的图片格式。';
    case 'GENERATED_IMAGE_INVALID_SIZE': return '生成图片为空或超过大小限制。';
    case 'PROVIDER_NOT_FOUND': return '生成模型配置不存在，请到设置中检查。';
    case 'PROVIDER_RESPONSE_NOT_JSON': return '生图接口未返回有效 JSON，请检查接口地址及服务状态。';
    default:
      if (code?.startsWith('PROVIDER_HTTP_') || ['PROVIDER_REQUEST_TIMEOUT', 'PROVIDER_CONNECTION_FAILED', 'PROVIDER_CREDENTIAL_MISSING', 'PROVIDER_DISABLED'].includes(code ?? '')) return analysisFailureMessage(code);
      return '生成失败，请复制错误信息或在任务中心查看详情。';
  }
}

export function analysisFailureMessage(code: string | null | undefined): string {
  switch (code) {
    case 'TASK_DATA_INVALID': return '任务或分析数据格式不符合要求，请重新创建分析任务。';
    case 'TASK_ASSET_MISSING': return '分析任务缺少图片，请重新选择图片并创建任务。';
    case 'TASK_FILE_NOT_FOUND': return '分析所需文件不存在，请检查原图及缓存文件。';
    case 'TASK_FILE_ACCESS_DENIED': return '没有访问分析所需文件的权限，请检查文件权限。';
    case 'TASK_DISK_FULL': return '磁盘空间不足，无法完成分析，请释放空间后重试。';
    case 'TASK_DATABASE_BUSY': return '图库数据库正忙，请稍后重试。';
    case 'PROVIDER_NOT_FOUND': return '分析模型配置不存在，请重新选择模型。';
    case 'PROVIDER_DISABLED': return '分析模型已停用，请在设置中启用或更换模型。';
    case 'CREDENTIAL_STORAGE_UNAVAILABLE': return '系统凭据存储不可用，请检查系统钥匙串后重新配置 API 密钥。';
    case 'PROVIDER_REQUEST_INVALID': return '无法创建模型请求，请检查服务地址与自定义请求头。';
    case 'PROVIDER_CREDENTIAL_MISSING': return '未配置 API 密钥，请在模型设置中填写。';
    case 'PROVIDER_DOES_NOT_SUPPORT_VISION': return '所选模型配置不支持视觉分析，请选择视觉模型。';
    case 'PROVIDER_HTTP_401': return '模型服务认证失败，请检查 API 密钥是否有效。';
    case 'PROVIDER_HTTP_403': return '模型服务拒绝访问，请检查账号权限及模型访问权限。';
    case 'PROVIDER_HTTP_400': return '模型服务拒绝了分析请求（HTTP 400）。请检查此平台的模型 ID、接口地址及请求参数；连接测试通过只代表模型列表可访问。';
    case 'PROVIDER_MODEL_UNAVAILABLE': return '服务报告模型不存在或不受支持。请将 Model ID 改为该平台实际提供的模型名称；其他平台的模型别名不一定通用。';
    case 'PROVIDER_JSON_MODE_UNSUPPORTED': return '服务明确拒绝 JSON 响应参数（response_format）。请使用支持 JSON 模式的接口或模型。';
    case 'PROVIDER_IMAGE_INPUT_UNSUPPORTED': return '服务明确表示不支持图片输入，请选择支持视觉分析的模型与接口。';
    case 'PROVIDER_HTTP_404': return '模型服务地址或模型不存在，请检查服务地址与模型 ID。';
    case 'PROVIDER_HTTP_413': return '模型服务拒绝了过大的图片请求，请减小图片尺寸后重试。';
    case 'PROVIDER_HTTP_429': return '模型服务限流或额度不足，请检查额度、降低并发或稍后重试。';
    case 'PROVIDER_HTTP_504': return '模型服务的上游网关等待超时（HTTP 504），不代表密钥或额度有误。请稍后重试、降低并发，或更换服务线路／模型；单纯延长本地超时通常无法解决。';
    case 'PROVIDER_REQUEST_TIMEOUT': return '模型服务响应超时，请检查网络或增加请求超时时间后重试。';
    case 'PROVIDER_CONNECTION_FAILED': return '无法连接模型服务，请检查服务地址、网络及代理设置。';
    case 'PROVIDER_RESPONSE_TOO_LARGE': return '模型返回内容超过大小限制，请更换模型后重试。';
    case 'PROVIDER_RESPONSE_NOT_JSON': return '模型接口的 HTTP 响应不是有效 JSON，请检查 Base URL 是否为 OpenAI Compatible 的 API 地址，以及代理是否返回了网页或错误文本。';
    case 'PROVIDER_RESPONSE_HTML': return '模型接口返回了 HTML 网页，而不是 API 数据。请检查 Base URL 是否缺少服务要求的 /v1 后缀，或填写了网站页面地址。';
    case 'PROVIDER_RESPONSE_EMPTY': return '模型接口返回了空响应，请检查服务状态或代理配置后重试。';
    case 'ANALYSIS_CONTENT_NOT_JSON': return '接口请求成功，但模型返回的分析文本不是有效 JSON，请重试或更换支持结构化分析的模型。';
    case 'PROVIDER_RESPONSE_INVALID': return '模型服务返回内容缺少分析文本，请检查接口兼容性或更换模型。';
    case 'ANALYSIS_RESPONSE_SCHEMA_INVALID': return '模型返回的分析数据缺少字段或格式不正确，请重试或更换模型。';
    case 'ASSET_NOT_FOUND': return '图片已不在图库中，请检查图片是否已移除。';
    case 'ASSET_PREVIEW_NOT_FOUND':
    case 'IMAGE_PREVIEW_UNAVAILABLE': return '无法读取图片预览，请检查原图是否存在，以及图片格式是否支持。';
    case 'ANALYSIS_IMAGE_TOO_LARGE': return '图片预览超过分析大小限制（15 MB），请缩小图片后重试。';
    case 'ANALYSIS_IMAGE_READ_DENIED': return '没有读取图片预览的权限，请检查文件访问权限。';
    case 'ANALYSIS_IMAGE_READ_FAILED': return '读取图片预览失败，请检查文件和缓存目录是否可访问。';
    case 'ANALYSIS_RESULT_SAVE_FAILED': return '模型分析已返回，但结果未能写入图库，请检查图库是否可写及磁盘空间。';
    case 'COLLECTION_ANALYSIS_REQUIRES_MULTIPLE_ASSETS': return '相册分析至少需要两张图片，请增加图片后重试。';
    case 'COLLECTION_ANALYSIS_REQUIRES_MULTIPLE_ANALYSES': return '相册分析至少需要两张已有视觉分析结果的图片，请先完成单图分析。';
    default:
      if (/^PROVIDER_HTTP_5\d{2}$/u.test(code ?? '')) return '模型服务发生错误，请稍后重试或更换服务。';
      if (/^PROVIDER_HTTP_\d{3}$/u.test(code ?? '')) return '模型服务返回异常状态，请检查服务配置后重试。';
      return '这条任务未保存具体失败原因，请重新分析以获取诊断信息。';
  }
}

export function fileOperationFailureMessage(code: string | null | undefined): string {
  switch (code) {
    case 'FILE_OPERATION_NOT_UNDOABLE': return '此操作当前不可撤销';
    case 'RECOVERY_DESTINATION_CONFLICT': return '目标文件存在冲突';
    case 'RECOVERY_FILES_MISSING':
    case 'RECOVERY_SOURCE_MISSING': return '关联文件已缺失';
    case 'INSUFFICIENT_SPACE': return '目标磁盘空间不足';
    case 'COMPENSATION_FAILED': return '部分文件未能恢复';
    default: return '操作失败，请检查图库状态后重试';
  }
}
