export type StartupFailureDialog = {
  title: string;
  content: string;
};

export function createStartupFailureDialog(_error: unknown): StartupFailureDialog {
  return {
    title: 'PhotoAllIsAI 无法启动',
    content: [
      '应用无法安全打开图库，因此已停止启动。原图和原文件夹不会被修改。',
      '请重新启动应用；如果问题持续，请保留应用数据，并使用已验证的完整图库备份进行恢复或联系支持。'
    ].join('\n\n')
  };
}
