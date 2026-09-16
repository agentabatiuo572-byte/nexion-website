export interface PublishProgress {
  kind: 'publish-progress';
  version: 1;
  title: string;
  output: string;
  updatedAt: string;
}

/** Fits the existing step.detail limit, including JSON escaping. */
export function encodePublishProgress(title: string, output: string, updatedAt: string): string {
  const progress: PublishProgress = {
    kind: 'publish-progress', version: 1, title: title.slice(0, 600),
    output: output.slice(-4000), updatedAt: new Date(updatedAt).toISOString(),
  };
  const tail = progress.output;
  let start = 0, end = tail.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    progress.output = tail.slice(middle);
    if (JSON.stringify(progress).length > 6000) start = middle + 1;
    else end = middle;
  }
  progress.output = tail.slice(start);
  return JSON.stringify(progress);
}

export function decodePublishProgress(detail: string | null | undefined): PublishProgress | null {
  if (!detail || detail.length > 6000) return null;
  try {
    const value: unknown = JSON.parse(detail);
    if (!value || typeof value !== 'object') return null;
    const p = value as Partial<PublishProgress>;
    if (p.kind !== 'publish-progress' || p.version !== 1 || typeof p.title !== 'string' || p.title.length > 600 ||
      typeof p.output !== 'string' || p.output.length > 4000 || typeof p.updatedAt !== 'string' ||
      new Date(p.updatedAt).toISOString() !== p.updatedAt) return null;
    return { kind: p.kind, version: p.version, title: p.title, output: p.output, updatedAt: p.updatedAt };
  } catch { return null; }
}

export function publishFailureAdvice(raw: string) {
  // Test names describe scenarios, not the failure cause; retain their actual error output.
  const diagnostic = raw.split(/\r?\n/).filter(line =>
    !decodePublishProgress(line) &&
    !/^\s*\[publish-progress\]/.test(line) &&
    !/^\s*\[verify\]\s*(?:开始检查[:：]|结束检查[:：].*\bexit 0\s*$)/.test(line) &&
    !/^\s*(?:\[[^\]]+\]\s*)?(?:[✔✓]|(?:not )?ok\s+\d+\b|#\s*Subtest:)/.test(line),
  ).join('\n');
  const cases = [
    ['test-dependency', /(?:TS2307|Cannot find module|找不到模块)[\s\S]*(?:text-layout-limits\.json|copy-advisory)|(?:text-layout-limits\.json|copy-advisory)[\s\S]*(?:TS2307|Cannot find module|找不到模块)/i,
      '发布自检缺少文案检查依赖', '维护人员需补齐隔离测试副本里的依赖文件，并通过发布器回归后再发布；无需修改草稿文案。'],
    ['timeout', /timed?\s*out|timeout|deadline|超时|超过.*(?:时限|执行时间)/i,
      '发布执行中断或等待超时', '查看最后执行的检查项；服务恢复或耗时问题处理后，重新检查并发布。'],
    ['identity', /unauthorized|not-current-job|not-the-claimed-runner|lock-expired|身份|口令|任务归属/i,
      '发布任务的身份或执行权限失效', '等待发布服务恢复并核实旧任务结果，再重新检查并发布。'],
    ['network', /ECONN|ENOTFOUND|fetch failed|HTTP\s*5\d{2}\b|network|网络|连接中断|连接失败/i,
      '发布服务连接中断', '等待连接恢复并核实执行结果；结果明确后再重新检查并发布。'],
    ['typecheck', /TS\d{4}|typecheck|类型检查|类型错误/i,
      '代码类型检查未通过', '维护人员需根据原始日志修复代码或依赖，再重新检查并发布；修改草稿不能解决代码错误。'],
    ['layout', /render-fit|canvas-geometry|deck-clearance|布局|溢出|行压行/i,
      '页面布局检查未通过', '按日志定位页面和语言，检查近期文案是否过长；调整对应字段，或由维护人员修复样式后再发布。'],
    ['copy', /i18n-parity|forbidden-word|publish-config|translation-stale|缺译|文案|禁用词/i,
      '文案或站点配置检查未通过', '处理当前前置检查中的字段问题；缺译可用一键补译，其余内容通过“去修复”定位修改。'],
    ['test', /test|测试|自检|回归|故障回归/i,
      '发布自检未通过', '查看原始日志中的首个失败项，由维护人员修复并通过自检后，再重新检查并发布。'],
    ['build', /build|构建|打包/i,
      '发布包构建未通过', '查看构建日志，由维护人员修复代码、依赖或资源缺失后，再重新检查并发布。'],
    ['interrupted', /执行器中断后恢复|执行器无响应/,
      '发布执行器曾中断或失去响应', '等待发布服务连接恢复并核实本次执行结果，再点击“重新检查并发布”；旧任务不会自动重跑。'],
  ] as const;
  const match = cases.find(([, pattern]) => pattern.test(diagnostic));
  return match ? { kind: match[0], reason: match[2], suggestion: match[3], raw }
    : { kind: 'unknown' as const, reason: '发布检查或执行未通过', suggestion: '展开原始日志查看失败项；原因处理后重新检查并发布。', raw };
}
