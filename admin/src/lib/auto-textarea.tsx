/* 随内容自增高的文本框。

   🔴 为什么需要(2026-09-01 第十轮独立验收 P1-2):上一版按 `字符数 / 46` 估行数,
   既不看真实列宽(三语并排时每栏只有 ~250px,窄窗更窄),**也完全不看内容里的换行符**。
   实测文案树里输入五行 → `rows` 仍是 2、`clientHeight 59` 而 `scrollHeight 124`,
   **一半以上内容看不见**;默认数据里带换行的那几条,第三行只露出半截笔画。
   而这一页恰恰是三语换行结构要对齐的地方(校验器有一条规则专门盯换行结构),
   看不全就没法对齐。CON04-⑤ 也明写「长文自增高、换行可见保留、超长不溢出」。

   做法:让浏览器自己量(`scrollHeight`),不估算。上限之后转为内部滚动,不撑爆页面。 */
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

const MAX_PX = 420;

export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = 0;
    const resize = () => {
      // 先归零再读,否则 scrollHeight 会被上一次撑开的高度锁住、只增不减。
      el.style.height = 'auto';
      const want = el.scrollHeight;
      el.style.height = `${Math.min(want, MAX_PX)}px`;
      el.style.overflowY = want > MAX_PX ? 'auto' : 'hidden';
      width = el.getBoundingClientRect().width;
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      // 自己写入的高度也会触发观察；只在宽度变化时重新量，避免循环。
      if (el.getBoundingClientRect().width !== width) resize();
    });
    observer?.observe(el);
    // 容器封顶后宽度可能不变，但响应式字号仍随窗口变化。
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [props.value]);
  return <textarea ref={ref} rows={2} {...props} />;
}
