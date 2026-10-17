import { humanPath } from './human-path';
import { splitFailReason } from './fail-reason';

const PROVIDERS: Record<string, string> = {
  zen: 'OpenCode Zen', gemini: 'Google Gemini', openai: 'OpenAI', anthropic: 'Anthropic Claude',
  deepseek: 'DeepSeek', groq: 'Groq', openrouter: 'OpenRouter', nvidia: 'NVIDIA NIM',
};
const RESULTS: Record<string, string> = {
  'invalid-key': '密钥无效', 'invalid-key-format': '密钥格式不正确', 'permission-denied': '缺少模型权限',
  'model-unavailable': '模型不可用', 'quota-exhausted': '服务额度不足', 'billing-required': '付款或额度未就绪',
  'rate-limited': '服务暂时限流', 'provider-unavailable': '服务暂不可用', 'network-error': '连接中断，结果待确认',
  interrupted: '操作中断，结果待确认', 'encryption-unavailable': '服务端加密配置不可用',
  'decryption-failed': '已有密钥无法读取', 'daily-limit': '已达每日翻译限额',
  'invalid-response': '服务返回内容无法使用', 'too-long': '内容超出长度限制',
};

/** Format only the display. Stored audit entries and CSV remain untouched. */
export function auditSummary(summary: string | null, action: string): string {
  if (!summary) return '';
  if (action.startsWith('ai.')) {
    return summary.split(';').map(part => {
      const value = part.trim();
      if (/^operation \d+$/.test(value)) return value.replace(/^operation (\d+)$/, '第 $1 次连接测试');
      if (/^credential \d+$/.test(value)) return value.replace(/^credential (\d+)$/, '密钥第 $1 版');
      if (value.startsWith('provider ')) return `服务商：${PROVIDERS[value.slice(9)] ?? '其他服务商'}`;
      if (value.startsWith('model ')) return `模型：${value.slice(6)}`;
      if (value.startsWith('result ')) return `测试结果：${RESULTS[value.slice(7)] ?? '未完成，请检查 AI 连接设置'}`;
      if (value.startsWith('status ')) return `连接状态：${value === 'status available' ? '可用' : RESULTS[value.slice(7)] ?? '待确认，请检查 AI 连接设置'}`;
      if (/^enabled [01]$/.test(value)) return `自动翻译：${value.endsWith('1') ? '开启' : '关闭'}`;
      if (/^daily characters \d+$/.test(value)) return value.replace(/^daily characters (\d+)$/, '每日翻译上限：$1 个字符');
      return '其他操作详情已记录，可导出查看';
    }).join('；');
  }
  if (action === 'config.publish.failed') {
    return splitFailReason(summary).human.replace(/请(?:查看详情中的失败原因|展开技术详情)/g, '请到发布与版本查看详情');
  }
  if (summary === 'validating/publishing') return '检查或发布进行中';
  if (summary === 'none' || summary === 'live=none') return '暂无线上版本';
  if (action.startsWith('geo.')) {
    const geo = /^enabled=(true|false) \[([^\]]*)\] page=(\d+)B(.*)$/.exec(summary);
    if (geo) {
      const regions = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
      const names = geo[2] ? geo[2].split(',').map(code => /^[A-Z]{2}$/.test(code) ? regions.of(code) ?? code : '未知地区').join('、') : '无';
      return `区域屏蔽：${geo[1] === 'true' ? '开启' : '关闭'}；地区：${names}；拦截页内容 ${geo[3]} 字节${geo[4]}`;
    }
    if (/^ready D1 authority v\d+ /.test(summary)) return '当前区域规则已就绪';
    if (summary.startsWith('re-materialize ')) return '从已保存规则恢复区域屏蔽配置';
  }
  return summary.replace(/\br(\d+)\b/g, '草稿修订 $1')
    .replace(/\blive=(v\d+)\b/g, '线上版本 $1')
    .replace(/\benabledLocales(?:\[\d+\])?|\b(?:copy|downloads|stats|skus|faq|announcement|seo|footer|legal)(?:\[[^\]]+\])?(?:\.[\w-]+(?:\[[^\]]+\])?)+/g, humanPath)
    .replace(/; 来源 (\d+); 待办 (\d+)/g, '；更新 $1 项翻译来源；新增 $2 项翻译待办');
}

export function auditReason(reason: string | null, action: string): string {
  if (!reason) return '—';
  if (action === 'auth.setup.fail') return ({ 'invalid-token': '初始化凭证无效', 'password-length': '管理员口令长度不符合要求' } as Record<string, string>)[reason] ?? '初始化未完成';
  if (action === 'login.fail' && reason === 'locked') return '尝试次数过多，暂时无法登录';
  if (action === 'config.save' && reason.startsWith('translation.')) {
    const names: Record<string, string> = { defaults: '恢复默认翻译', enqueue: '安排翻译任务', retry: '重试翻译任务', cancel: '取消翻译任务', apply: '应用 AI 翻译', keep: '保留人工翻译', retranslate: '重新翻译' };
    return names[reason.slice(12)] ?? '更新翻译设置';
  }
  return reason;
}
