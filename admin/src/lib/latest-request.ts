/** 只允许同一数据面的最后一次请求提交结果；旧响应和旧错误都必须作废。 */
export class LatestRequest {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
