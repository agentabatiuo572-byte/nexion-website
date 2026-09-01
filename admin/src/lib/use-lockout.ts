/* 限流锁定倒计时(429)。
   服务端在 429 里给了 `retryAfterSec`(实测 900 = 15 分钟)和 `Retry-After` 头,
   登录页读了它、做了倒计时并禁用按钮;初始化页只写了一句「稍后再试」,
   既不说要等多久、按钮也不禁用 —— 于是人会每隔几秒再点一次,每一次都是 429。
   同一个服务端信号两个消费面各写各的,必然漂;抽到这里,两页共用一份。 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';

export interface Lockout {
  /** 剩余秒数;0 = 未锁定 */
  sec: number;
  /** 是 429 就吃掉并起倒计时,返回 true;不是则返回 false 交给调用方继续判别 */
  capture: (ex: unknown) => boolean;
}

export function useLockout(): Lockout {
  const [sec, setSec] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载后计时器还在跑会对着已卸载的组件 setState;这里收干净
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  function capture(ex: unknown): boolean {
    if (!(ex instanceof ApiError) || ex.status !== 429) return false;
    /* 服务端没给或给了非法值时退到 900:宁可多等,也好过显示「0 秒后可再试」把人骗去空点。
       `|| 900` 同时兜住 NaN 与 0。 */
    const s = Number(ex.body.retryAfterSec ?? 0) || 900;
    if (timer.current) clearInterval(timer.current);
    setSec(s);
    timer.current = setInterval(
      () => setSec((v) => (v <= 1 ? (timer.current && clearInterval(timer.current), 0) : v - 1)),
      1000,
    );
    return true;
  }

  return { sec, capture };
}

/** 「尝试过多,15 分钟后再试(897s)」——分钟给人估量,秒数让人看见它真的在走 */
export function lockoutText(sec: number): string {
  return `尝试过多,${Math.ceil(sec / 60)} 分钟后再试(${sec}s)`;
}
