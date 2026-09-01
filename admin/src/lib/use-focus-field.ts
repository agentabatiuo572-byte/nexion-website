/* 「去修复」的字段级定位(PRD CON13-⑥「定位到红字段」)。
   🔴 为什么做成共享钩子而不是逐页手写(2026-09-01 第八轮走查):
   上一轮我在链接上带了 `?focus=<字段>`,但**目标页一个消费者都没有**——
   参数带了、没人读,点过去仍然停在页顶,那就是个摆设。
   逐页手写会重复八遍,而重复八遍的东西迟早有一两处漏掉;做成一个钩子,页面只需
   给字段容器加 `data-field="<路径>"`,滚动与高亮由这里统一负责。

   用法:页面顶层调 `useFocusField()`;字段容器加 `data-field={路径}`。
   找不到对应容器时**不静默**:滚到页顶并在控制台留一行,便于发现「链接给的路径页面认不出」。 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function useFocusField(): void {
  const { search } = useLocation();
  useEffect(() => {
    const want = new URLSearchParams(search).get('focus');
    if (!want) return;
    // 等一帧,让页面数据渲染完再找
    const t = window.setTimeout(() => {
      const el =
        document.querySelector<HTMLElement>(`[data-field="${CSS.escape(want)}"]`) ??
        // 退一步:按前缀找(路径可能比页面粒度更细,例如 downloads.ios.url → downloads.ios)
        document.querySelector<HTMLElement>(`[data-field="${CSS.escape(want.split('.').slice(0, 2).join('.'))}"]`);
      if (!el) {
        console.warn(`[focus] 页面上找不到字段容器:${want}(链接给的路径这一页认不出)`);
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('focus-flash');
      window.setTimeout(() => el.classList.remove('focus-flash'), 2400);
      el.querySelector<HTMLElement>('input, textarea, select')?.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, [search]);
}
