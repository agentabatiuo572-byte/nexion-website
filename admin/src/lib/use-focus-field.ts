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
      /* 🔴 **逐级剥尾**,而不是只试「原串」和「前两段」(2026-09-01 第十轮独立验收 P1:
         九条红项里八条落空)。红项路径来自校验器,粒度比页面容器细得多,
         而且同一件事在仓库里有**两种记法**并存:
           校验器 → `skus.phone.tagline.en`(点号 + 稳定 id)
           改动 diff → `skus[0].priceUSD`(方括号 + 下标)
         页面在同一个元素上把两种都标出来(见各页 data-field / data-field-alt),
         这里从最长前缀往回退,退到哪一级能找到就停在哪一级 ——
         **精确到字段是加分,精确到那张卡就已经够用**:人到了地方自然看得见红字。
         (根治方向是让产出方传结构而不是拼字符串,见
          docs/changes/2026-09-01-cross-surface-string-structural-reflection.md;
          在那之前,匹配这件事只允许有这一处实现。) */
      const find = (sel: string) => document.querySelector<HTMLElement>(`[data-field="${CSS.escape(sel)}"], [data-field-alt="${CSS.escape(sel)}"]`);
      const tryPath = (p: string) => {
        const segs = p.split('.');
        for (let n = segs.length; n > 0; n--) {
          const hit = find(segs.slice(0, n).join('.'));
          if (hit) return hit;
        }
        return null;
      };
      /* 语言码对「定位到哪个容器」没有意义:三语通常共处一处(文案树一张卡里三个输入框),
         所以原串找不到时,把路径里的语言段去掉再找一遍。
         这一步放在钩子里而不是让每页多标两个属性 —— 同一条规则只该有一处实现。 */
      const el = tryPath(want) ?? tryPath(want.split('.').filter((s) => !/^(en|vi|zh)$/.test(s)).join('.'));
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
