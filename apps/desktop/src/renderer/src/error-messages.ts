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
