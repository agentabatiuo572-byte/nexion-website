/* 全站交互引擎 R47(axiom 方向,自研实现;参数规格见 PRD/specs/WEBSITE-axiom-teardown.md)。
   ① 点阵地球背景(R47 取代洛伦兹,规格 docs/changes/2026-08-27-dotted-globe.md):陆地点阵球 + 12 算力枢纽
      呼吸/扩散环 + 大圆弧流光;五姿态链式插值沿用(滚动驱动旋转,yaw 单调 -105°→+105°);
      首绘 1s zoom-fade 由 CSS 承担(tokens.css `html.js #x-bg`);reduced-motion 静帧在 resize 后重画。
   ② Lenis:duration 1.2 + easeOutExpo(恒定收尾时长的「奢滑」);站内锚点补间 + 目标获焦;修饰键点击放行原生。
   ③ 行遮罩逐行上滑(display 标题唯一进场方式;可访问文本走 .x-sr,不给无角色宿主挂 aria-label)
   ④ 打字机:R45 改「影子层定版面、打字层叠打」——不再按 ch 数猜宽度(CJK 一字 1em、chip 内衬、右对齐都曾因此折行/跳动),
      注册即隐藏原文(不再「满亮再清空」),终态还原纯文本。
   ⑤ data-rv 次要块 reveal(阈值 .05/底-20px,位移 12px);进场结束加 .rv-done 把过渡交还给元素自己的 hover 规则。
   ⑥ 设备 deck:整排连续推进传送带(恒一步差,无显隐翻转),步距 1.0923 卡宽;桌面编舞时卡图改 eager(裁切框挡住了 lazy 预取)。
   ⑦ 三列滚动视差(反白卡区);⑧ UTC 时钟(秒奇偶冒号,锁墙钟秒)。
   首载四拍编排由 html.x-boot + CSS 时间线承担(仅首页 navigate 型导航,Base.astro 头部内联脚本在首帧前判定)。
   reduced-motion:全部降级直显。 */
import Lenis from 'lenis';
import { GLOBE_DOTS_B64, GLOBE_DOTS_N } from './globe-dots';

/* 🔴 「引擎到货了」的信号,必须在模块**最顶上**挂,不能等 boot():
   [data-rv] 的隐藏初始态由 html.js 开启(内联脚本首帧前就挂,bundle 挂掉也照挂),
   而解除隐藏靠的是本模块的 IntersectionObserver 加 .in。bundle 一失败,首页 35 个内容块
   永远停在 opacity:0,/nex/ 连 H1 都是 data-rv、整页近乎空白。
   兜底的条件只能是「引擎没到货」(html.js:not(.fx)),不能是「超时」——
   data-rv 是滚动进场,单纯超时会让整页提前全显。挂在顶上是为了尽早熄掉那条兜底动画:
   延迟到 DOMContentLoaded 才挂,慢网上会先闪一下再被隐藏。 */
document.documentElement.classList.add('fx');

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
/* 开场钟:四拍的 CSS 时间线锚在 html.x-boot 落地(首帧前),JS 拍(标题)以本模块执行时刻近似锚点 */
const BOOT_T0 = performance.now();
/* 首屏四拍必须共用一个钟:副题/下载/数字条走 CSS 的 html.x-boot 动画(锚点 = 元素首次渲染),
   标题走这里的 setTimeout(锚点 = fx 模块执行时刻)。两者之差 = JS 到达延迟,慢网上能到 1–3 秒,
   于是标题会排到副题后面(1.5Mbps 实测晚 17–49ms、0.75Mbps 晚 366ms)。取两个锚点里更早的那个。 */
const PAINT_T0 = (() => {
  try {
    return performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? BOOT_T0;
  } catch {
    return BOOT_T0;
  }
})();
const BEAT_T0 = Math.min(BOOT_T0, PAINT_T0);

let lenisInst: Lenis | null = null;
/* 文档锁按引用计数:菜单与灯箱共用 documentElement.style.overflow,各自 close 时无条件清空,
   谁先关谁就把另一层的锁也解了(当前三重互斥使真实操作不可达,但新增第三个锁主时会复活) */
let lockN = 0;
const scrollLock = (on: boolean) => {
  lockN = Math.max(0, lockN + (on ? 1 : -1));
  document.documentElement.style.overflow = lockN > 0 ? 'hidden' : '';
  if (!lenisInst) return;
  if (on) lenisInst.stop();
  else lenisInst.start();
};

/* 可用视口宽(html 布局宽,不含经典滚动条/滚动条槽)→ --x-vw,画布缩放系数的输入(tokens.css 以 100vw 兜底)。
   why:100vw 含滚动条而 fixed/流盒不含,Windows 经典滚动条 15px 曾让 1440–1935 宽画布多 15px 被裁。
   不用 clientWidth:无头/隐藏滚动条环境下它不减 scrollbar-gutter 的槽宽,与布局分家(实测 1440 vs 1425)。 */
const setVw = () =>
  document.documentElement.style.setProperty('--x-vw', `${document.documentElement.getBoundingClientRect().width}px`);

/* ---------- ① 点阵地球算力网络(Dotted Globe;R47.1) ----------
   取代洛伦兹吸引子(R2/08-20)——规格 docs/changes/2026-08-27-dotted-globe.md + 主人 08-27 改令:
   ① 100 枢纽(50 城市 + 50 随机陆点,R48.13 翻倍)/ 全弧常亮基线(~142 条,所有节点同时连线)/ 14 条流光同飞;② 地球**常态缓慢自转**(80s/圈,spinYaw 按运行
   时间累积,暂停/切页归来不跳帧)+ **滚动耦合旋转**(R47.2 改令④:转速随滑动速度/方向,单帧封顶),
   五姿态链管 cx/cy/r/pitch(缩放与位移),经度 = 常转 + 滚动耦合——
   R2「静止零重渲」契约由此退役,常转即常渲(辉光 180ms 节流保留);③ 原版鼠标推斥回归
   (半径 160/力 90,陆点/枢纽/弧同场变形,coarse 无)。R33 纪律沿用:黑底离屏 + 预乘不透明色 +
   screen 合成 → 重叠零增亮;reduced-motion 静帧(不转)。 */
function initGlobe() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  /* 底色单一真源(tokens.css 的 --x-bg),读不到才退字面量(R2 教训沿袭) */
  const BG = getComputedStyle(document.documentElement).getPropertyValue('--x-bg').trim() || '#0c0c0d';
  const D2R = Math.PI / 180;

  /* ── 陆地点阵:生成物 globe-dots.ts(小端 Int16 centi-degree 交错 [lat,lon])→ 单位向量。
     坐标系:ux=cosφ·sinλ,uy=sinφ(北为上),uz=cosφ·cosλ;绕 Y 转 yaw 后面向观者的经度 = -yaw。
     coarse 隔一取一:行内密度减半,行错位节奏保留。 */
  const N = coarse ? GLOBE_DOTS_N >> 1 : GLOBE_DOTS_N;
  const ux = new Float32Array(N),
    uy = new Float32Array(N),
    uz = new Float32Array(N);
  {
    const bin = atob(GLOBE_DOTS_B64);
    const dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    for (let i = 0; i < N; i++) {
      const s = (coarse ? i * 2 : i) * 4;
      const la = (dv.getInt16(s, true) / 100) * D2R;
      const lo = (dv.getInt16(s + 2, true) / 100) * D2R;
      const cl = Math.cos(la);
      ux[i] = cl * Math.sin(lo);
      uy[i] = Math.sin(la);
      uz[i] = cl * Math.cos(lo);
    }
  }

  /* ── 算力枢纽:50 具名城市锚点(R47.1/R47.4)+ R48.13 随机陆点 50(见下方翻倍块);
     纯图形无标签——不构成设施声明;越南两点在列不突出 */
  const HUBS: ReadonlyArray<readonly [number, number]> = [
    [39.0, -77.5] /* 0 阿什本 */,
    [37.3, -121.9] /* 1 圣何塞 */,
    [47.6, -122.33] /* 2 西雅图 */,
    [41.88, -87.63] /* 3 芝加哥 */,
    [19.43, -99.13] /* 4 墨西哥城 */,
    [-23.55, -46.63] /* 5 圣保罗 */,
    [-34.6, -58.38] /* 6 布宜诺斯艾利斯 */,
    [51.51, -0.13] /* 7 伦敦 */,
    [52.37, 4.9] /* 8 阿姆斯特丹 */,
    [48.86, 2.35] /* 9 巴黎 */,
    [50.11, 8.68] /* 10 法兰克福 */,
    [59.33, 18.07] /* 11 斯德哥尔摩 */,
    [52.23, 21.01] /* 12 华沙 */,
    [25.2, 55.27] /* 13 迪拜 */,
    [-26.2, 28.05] /* 14 约翰内斯堡 */,
    [6.45, 3.4] /* 15 拉各斯 */,
    [19.08, 72.88] /* 16 孟买 */,
    [12.97, 77.59] /* 17 班加罗尔 */,
    [1.35, 103.82] /* 18 新加坡 */,
    [10.82, 106.63] /* 19 胡志明市 */,
    [13.76, 100.5] /* 20 曼谷 */,
    [-6.2, 106.85] /* 21 雅加达 */,
    [35.68, 139.69] /* 22 东京 */,
    [37.57, 126.98] /* 23 首尔 */,
    [-33.87, 151.21] /* 24 悉尼 */,
    [-36.85, 174.76] /* 25 奥克兰 */,
    [43.65, -79.38] /* 26 多伦多 */,
    [32.78, -96.8] /* 27 达拉斯 */,
    [25.77, -80.19] /* 28 迈阿密 */,
    [34.05, -118.24] /* 29 洛杉矶 */,
    [4.71, -74.07] /* 30 波哥大 */,
    [-12.05, -77.04] /* 31 利马 */,
    [-33.45, -70.67] /* 32 圣地亚哥 */,
    [40.42, -3.7] /* 33 马德里 */,
    [45.46, 9.19] /* 34 米兰 */,
    [53.35, -6.26] /* 35 都柏林 */,
    [47.37, 8.54] /* 36 苏黎世 */,
    [60.17, 24.94] /* 37 赫尔辛基 */,
    [24.71, 46.68] /* 38 利雅得 */,
    [41.01, 28.98] /* 39 伊斯坦布尔 */,
    [30.04, 31.24] /* 40 开罗 */,
    [-1.29, 36.82] /* 41 内罗毕 */,
    [-33.92, 18.42] /* 42 开普敦 */,
    [28.61, 77.21] /* 43 德里 */,
    [13.08, 80.27] /* 44 金奈 */,
    [34.69, 135.5] /* 45 大阪 */,
    [14.6, 120.98] /* 46 马尼拉 */,
    [21.03, 105.85] /* 47 河内 */,
    [3.14, 101.69] /* 48 吉隆坡 */,
    [-31.95, 115.86] /* 49 珀斯 */,
  ];
  /* R48.13 主人改令:枢纽随机翻倍(50 城市 + 50 随机陆点 = 100)。随机点从陆地点阵取
     (种子 PRNG,确定性可复现),与已放枢纽保持 ≥0.1 rad(约 640km)间距免叠压;
     纯图形无标签——不构成设施声明。 */
  const NH0 = HUBS.length;
  const NH = NH0 * 2;
  const hx3 = new Float32Array(NH),
    hy3 = new Float32Array(NH),
    hz3 = new Float32Array(NH);
  for (let h = 0; h < NH0; h++) {
    const la = HUBS[h][0] * D2R,
      lo = HUBS[h][1] * D2R,
      cl = Math.cos(la);
    hx3[h] = cl * Math.sin(lo);
    hy3[h] = Math.sin(la);
    hz3[h] = cl * Math.cos(lo);
  }
  {
    let seed = 0x9edc1d; /* 种子=品牌色,只为好记;mulberry32 */
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    let minCos = Math.cos(0.1);
    let placed = NH0;
    let guard = 0;
    while (placed < NH) {
      if (++guard > 8000) {
        guard = 0;
        minCos = Math.cos(Math.acos(minCos) * 0.8); /* 兜底:陆点抽不满就放宽间距,保证必放满 */
      }
      const i = (rnd() * N) | 0;
      const x = ux[i],
        y = uy[i],
        z = uz[i];
      let ok = true;
      for (let h = 0; h < placed; h++) {
        if (hx3[h] * x + hy3[h] * y + hz3[h] * z > minCos) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      hx3[placed] = x;
      hy3[placed] = y;
      hz3[placed] = z;
      placed++;
    }
  }

  /* ── 75 条大圆弧(R47.1 改令① + R47.4 二次加密;每枢纽 ≥1,区域网 + 跨洋干线),slerp 采样,弧中点抬离球面 6% */
  const ARCS: ReadonlyArray<readonly [number, number]> = [
    [0, 3] /* 阿什本–芝加哥 */,
    [3, 2] /* 芝加哥–西雅图 */,
    [2, 1] /* 西雅图–圣何塞 */,
    [1, 0] /* 圣何塞–阿什本 */,
    [4, 1] /* 墨西哥城–圣何塞 */,
    [4, 5] /* 墨西哥城–圣保罗 */,
    [5, 6] /* 圣保罗–布宜诺斯艾利斯 */,
    [5, 0] /* 圣保罗–阿什本 */,
    [0, 7] /* 阿什本–伦敦(跨大西洋) */,
    [5, 15] /* 圣保罗–拉各斯(南大西洋) */,
    [7, 8] /* 伦敦–阿姆斯特丹 */,
    [8, 10] /* 阿姆斯特丹–法兰克福 */,
    [9, 7] /* 巴黎–伦敦 */,
    [9, 10] /* 巴黎–法兰克福 */,
    [10, 12] /* 法兰克福–华沙 */,
    [11, 8] /* 斯德哥尔摩–阿姆斯特丹 */,
    [15, 14] /* 拉各斯–约翰内斯堡 */,
    [14, 13] /* 约翰内斯堡–迪拜 */,
    [13, 10] /* 迪拜–法兰克福 */,
    [13, 16] /* 迪拜–孟买 */,
    [16, 17] /* 孟买–班加罗尔 */,
    [17, 18] /* 班加罗尔–新加坡 */,
    [18, 19] /* 新加坡–胡志明市 */,
    [18, 20] /* 新加坡–曼谷 */,
    [18, 21] /* 新加坡–雅加达 */,
    [19, 20] /* 胡志明市–曼谷 */,
    [19, 22] /* 胡志明市–东京 */,
    [22, 23] /* 东京–首尔 */,
    [22, 1] /* 东京–圣何塞(跨太平洋) */,
    [23, 2] /* 首尔–西雅图(跨太平洋) */,
    [24, 18] /* 悉尼–新加坡 */,
    [24, 25] /* 悉尼–奥克兰 */,
    [26, 0] /* 多伦多–阿什本 */,
    [26, 3] /* 多伦多–芝加哥 */,
    [27, 3] /* 达拉斯–芝加哥 */,
    [27, 29] /* 达拉斯–洛杉矶 */,
    [29, 1] /* 洛杉矶–圣何塞 */,
    [28, 0] /* 迈阿密–阿什本 */,
    [28, 30] /* 迈阿密–波哥大 */,
    [4, 27] /* 墨西哥城–达拉斯 */,
    [30, 31] /* 波哥大–利马 */,
    [31, 32] /* 利马–圣地亚哥 */,
    [32, 6] /* 圣地亚哥–布宜诺斯艾利斯 */,
    [26, 35] /* 多伦多–都柏林(跨大西洋) */,
    [28, 33] /* 迈阿密–马德里(跨大西洋) */,
    [5, 42] /* 圣保罗–开普敦(南大西洋) */,
    [5, 33] /* 圣保罗–马德里 */,
    [35, 7] /* 都柏林–伦敦 */,
    [33, 9] /* 马德里–巴黎 */,
    [34, 36] /* 米兰–苏黎世 */,
    [36, 10] /* 苏黎世–法兰克福 */,
    [34, 9] /* 米兰–巴黎 */,
    [37, 11] /* 赫尔辛基–斯德哥尔摩 */,
    [12, 39] /* 华沙–伊斯坦布尔 */,
    [39, 40] /* 伊斯坦布尔–开罗 */,
    [40, 13] /* 开罗–迪拜 */,
    [38, 13] /* 利雅得–迪拜 */,
    [40, 15] /* 开罗–拉各斯 */,
    [41, 13] /* 内罗毕–迪拜 */,
    [41, 14] /* 内罗毕–约翰内斯堡 */,
    [42, 14] /* 开普敦–约翰内斯堡 */,
    [43, 16] /* 德里–孟买 */,
    [43, 13] /* 德里–迪拜 */,
    [44, 17] /* 金奈–班加罗尔 */,
    [44, 18] /* 金奈–新加坡 */,
    [47, 19] /* 河内–胡志明市 */,
    [47, 23] /* 河内–首尔 */,
    [46, 22] /* 马尼拉–东京 */,
    [46, 18] /* 马尼拉–新加坡 */,
    [48, 18] /* 吉隆坡–新加坡 */,
    [45, 22] /* 大阪–东京 */,
    [25, 22] /* 奥克兰–东京(跨太平洋) */,
    [29, 22] /* 洛杉矶–东京(跨太平洋) */,
    [49, 18] /* 珀斯–新加坡 */,
    [49, 24] /* 珀斯–悉尼 */,
  ];
  /* R48.13:随机枢纽全部入网(主人令「所有节点同时连线」)——每个新枢纽接最近邻一条,
     每第 3 个再补一条次近邻织密区域网;老 50 枢纽本就每枢纽 ≥1。 */
  const ARCS_ALL: Array<readonly [number, number]> = [...ARCS];
  for (let h = NH0; h < NH; h++) {
    let b1 = -1,
      d1 = -2,
      b2 = -1,
      d2 = -2;
    for (let b = 0; b < NH; b++) {
      if (b === h) continue;
      const d = hx3[h] * hx3[b] + hy3[h] * hy3[b] + hz3[h] * hz3[b];
      if (d > d1) {
        d2 = d1;
        b2 = b1;
        d1 = d;
        b1 = b;
      } else if (d > d2) {
        d2 = d;
        b2 = b;
      }
    }
    ARCS_ALL.push([h, b1]);
    if ((h - NH0) % 3 === 0 && b2 >= 0) ARCS_ALL.push([h, b2]);
  }
  /* R47.5 评审修复:近邻拥挤度阻尼——地理聚集区(欧洲群 4-7 枢纽叠压)辉光糊成亮斑;
     0.13 rad(约 830km)内邻居数 n,辉光透明度 ×1/√n、辉光半径 ×n^-0.25,孤立枢纽不受影响;
     核心亮点不衰减(保持「多个独立枢纽」的辨识) */
  const haloA = new Float32Array(NH),
    haloR = new Float32Array(NH);
  {
    const COS_NEAR = Math.cos(0.13);
    for (let a = 0; a < NH; a++) {
      let n = 1;
      for (let b = 0; b < NH; b++) {
        if (b !== a && hx3[a] * hx3[b] + hy3[a] * hy3[b] + hz3[a] * hz3[b] > COS_NEAR) n++;
      }
      haloA[a] = 1 / Math.sqrt(n);
      haloR[a] = n ** -0.25;
    }
  }

  const NA = ARCS_ALL.length,
    ASEG = 48;
  const arc3 = new Float32Array(NA * (ASEG + 1) * 3);
  const arcAng = new Float32Array(NA);
  for (let a = 0; a < NA; a++) {
    const [h0, h1] = ARCS_ALL[a];
    const dot = Math.max(-1, Math.min(1, hx3[h0] * hx3[h1] + hy3[h0] * hy3[h1] + hz3[h0] * hz3[h1]));
    const om = Math.acos(dot),
      so = Math.sin(om) || 1e-6;
    arcAng[a] = om;
    for (let k = 0; k <= ASEG; k++) {
      const t = k / ASEG;
      const w0 = Math.sin((1 - t) * om) / so,
        w1 = Math.sin(t * om) / so;
      /* R47.5 评审修复:抬升随弧跨度缩放(封顶 0.9 rad)——恒定 0.06R 曾让欧洲群短弧
         (弦 ~100px 拱 ~30px)立起成「发卡/套索」,三宽度多姿态复现;长弧姿态不变 */
      const lift = 1 + 0.06 * Math.min(1, om / 0.9) * Math.sin(Math.PI * t);
      const o = (a * (ASEG + 1) + k) * 3;
      arc3[o] = (hx3[h0] * w0 + hx3[h1] * w1) * lift;
      arc3[o + 1] = (hy3[h0] * w0 + hy3[h1] * w1) * lift;
      arc3[o + 2] = (hz3[h0] * w0 + hz3[h1] * w1) * lift;
    }
  }

  /* R30 同相位:全部落在品牌 #9EDC1D 色相带(particle-hue 门读以下标注;改色值必同步改标注)。
     亮度阶:陆点 < 弧基线 < 枢纽 < 流光。
     HUE-GUARD:dot-dim (40, 55, 7)
     HUE-GUARD:dot-lit (150, 205, 38)
     HUE-GUARD:hub (190, 245, 52)
     HUE-GUARD:arc-base (52, 68, 13) */
  const SHB = 12;
  const dotSprites: HTMLCanvasElement[] = [];
  for (let b = 0; b < SHB; b++) {
    const t = (b + 0.5) / SHB;
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = `rgb(${Math.round(40 + 110 * t)},${Math.round(55 + 150 * t)},${Math.round(7 + 31 * t)})`;
    g.beginPath();
    g.arc(8, 8, 6, 0, Math.PI * 2);
    g.fill();
    dotSprites.push(c);
  }
  const hubCore = document.createElement('canvas');
  {
    hubCore.width = 16;
    hubCore.height = 16;
    const g = hubCore.getContext('2d')!;
    g.fillStyle = 'rgb(190,245,52)';
    g.beginPath();
    g.arc(8, 8, 6, 0, Math.PI * 2);
    g.fill();
  }
  const hubHalo = document.createElement('canvas');
  {
    hubHalo.width = 48;
    hubHalo.height = 48;
    const g = hubHalo.getContext('2d')!;
    const rg = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    rg.addColorStop(0, 'rgba(190,245,52,0.85)');
    rg.addColorStop(0.45, 'rgba(150,205,38,0.28)');
    rg.addColorStop(1, 'rgba(150,205,38,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 48, 48);
  }

  const body = document.createElement('canvas');
  const bctx = body.getContext('2d')!;
  /* R32:辉光离屏——主体的模糊副本,只在主体重渲时烘焙,帧循环零滤镜成本 */
  const glow = document.createElement('canvas');
  const gctx = glow.getContext('2d')!;
  /* 网络层:枢纽/弧/流光,每帧重画(唯一常驻动帧成本;黑底 + screen 同 R34 流光层) */
  const net = document.createElement('canvas');
  const nctx = net.getContext('2d')!;

  let W = 0,
    H = 0;

  interface Pose {
    cx: number;
    cy: number;
    r: number;
    pitch: number;
  }
  /* 姿态语义(R47.1):滚动只管构图——位置 / r=球半径 px / pitch(±0.35,极区无大陆不给正脸);
     经度旋转不归姿态管,由下方 spinYaw 常转累积(改令②)。数值为首轮构图值,评审轮微调。 */
  const R0 = () => 0.46 * Math.min(W, H);
  const poseHome = (): Pose => ({ cx: 0.5 * W, cy: 0.6 * H, r: R0(), pitch: 0.31 });
  const poseA = (): Pose => ({ cx: 0.33 * W, cy: 0.68 * H, r: 0.55 * R0(), pitch: 0.1 });
  const poseB = (): Pose => ({ cx: 0.65 * W, cy: 0.5 * H, r: 0.7 * R0(), pitch: 0.35 });
  const poseC = (): Pose => ({ cx: 0.5 * W, cy: 0.55 * H, r: 1.6 * R0(), pitch: 0.2 });
  const poseD = (): Pose => {
    /* 页脚:球心压到视口下缘外,球缘呈地平线弧 */
    const r = 1.9 * R0();
    return { cx: 0.5 * W, cy: H + 0.62 * r, r, pitch: 0.3 };
  };
  /* 常态自转(改令②):面向经度 = -yaw,开局东南亚(越南居中偏下),向西 80s/圈;
     只在运行帧累积(dt 封顶 100ms)——暂停/切页归来不跳帧;reduced-motion 恒为 HOME_YAW 静帧。 */
  const HOME_YAW = -105 * D2R;
  const SPIN = (2 * Math.PI) / 80000; /* rad/ms,80s 一圈 */
  /* 改令④(R47.2):滚动耦合旋转——转速随滑动速度、方向随滑动方向,叠在常转上。
     增益按真实滚轮路径(Lenis 平滑后)标定:0.0003 时轻滚只有 2.5°/s,被 4.5°/s 常转
     盖住(主人实感「没生效」);0.0008 → 轻滚 6.7°/s / 中滚 ~22°/s / 猛滚 ~59°/s,
     整页 ~1.3 万 px ≈ 1.6 圈。单帧封顶 ±0.09 rad——锚点/End 键的瞬时长跳只吃一帧份额。 */
  const SCROLL_K = 0.0008;
  const KICK_CAP = 0.09;
  let spinYaw = HOME_YAW;
  let lastT = -1;
  let lastSy = -1;
  /* R21 绑定沿用:statement→A(左下小) about→B(右中景) 叠卡→C(特写) 收尾黑区→D(最大);白带段被盖住 */
  const ANCHOR_IDS = ['social', 'mission', 'devices', 'final-cta'];
  let anchors: (HTMLElement | null)[] = [];
  const smooth = (e: number) => e * e * (3 - 2 * e);
  /* dly:延迟起混(占进区行程比例)——特写档 C 从区顶即起混会提前撑大上一屏背景(R23) */
  const prog = (el: HTMLElement | null, dly = 0) => {
    if (!el) return 0;
    const raw = Math.max(0, Math.min(1, (innerHeight - el.getBoundingClientRect().top) / innerHeight));
    const e = dly > 0 ? Math.max(0, Math.min(1, (raw - dly) / (1 - dly))) : raw;
    return smooth(e);
  };
  const mix = (a: Pose, b: Pose, p: number): Pose => ({
    cx: a.cx + p * (b.cx - a.cx),
    cy: a.cy + p * (b.cy - a.cy),
    r: a.r + p * (b.r - a.r),
    pitch: a.pitch + p * (b.pitch - a.pitch),
  });

  const mouse = { x: -9999, y: -9999 };
  let tiltX = 0,
    tiltY = 0,
    driftX = 0,
    driftY = 0;
  let dirty = true;
  let rR = -1,
    rCx = 0,
    rCy = 0,
    rYaw = 99,
    rPitch = 99;
  /* 尺寸标尺 = sqrt(r/R0):特写档点径/线宽按 0.5 次幂长,防糊块 */
  let q = 1;
  /* 辉光烘焙节流(R47):上次烘焙时刻 + 「主体新于辉光」标记,停稳补烘 */
  let glowAt = -1e9;
  let glowStale = false;
  const dbg = { renders: 0, yaw: 0, pitch: 0, r: 0, fl: 0, tiltX: 0, tiltY: 0, driftX: 0, driftY: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  /* R36:高分屏适配——渲染精度乘 DPR(上限 1.5),离屏缓存机制不变 */
  let DPR = 1;
  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    /* R47.5:物理像素预算 ≤5.5M(评审在无显卡软光栅下量到 2560 掉帧;有头 GPU 实测 60fps,
       此为高 DPR × 超宽组合的保险,常规机型不触发)——超预算等比降内部分辨率 */
    if (W * H * DPR * DPR > 5.5e6) DPR = Math.max(0.75, Math.sqrt(5.5e6 / (W * H)));
    for (const c of [canvas, body, glow, net]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    gctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    nctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    dirty = true;
    /* R45:reduced-motion 没有帧循环,位图被 resize 清空后必须当场重画,否则背景从此全黑 */
    if (reduced && W > 0 && H > 0) drawStatic();
  };

  const px = new Float32Array(N),
    py = new Float32Array(N),
    dep = new Float32Array(N);
  const hpx = new Float32Array(NH),
    hpy = new Float32Array(NH),
    hdep = new Float32Array(NH);
  const apx = new Float32Array(NA * (ASEG + 1)),
    apy = new Float32Array(NA * (ASEG + 1));
  const avis = new Uint8Array(NA * (ASEG + 1));

  const renderBody = (cx: number, cy: number, R: number, yaw: number, pitch: number) => {
    dbg.renders++;
    q = Math.sqrt(Math.max(0.2, R / R0()));
    const cyw = Math.cos(yaw),
      syw = Math.sin(yaw);
    const cp = Math.cos(pitch),
      sp = Math.sin(pitch);

    for (let i = 0; i < N; i++) {
      const x1 = ux[i] * cyw + uz[i] * syw;
      const z1 = uz[i] * cyw - ux[i] * syw;
      const y2 = uy[i] * cp - z1 * sp;
      const z2 = uy[i] * sp + z1 * cp;
      px[i] = cx + x1 * R;
      py[i] = cy - y2 * R;
      dep[i] = z2;
    }

    for (let h = 0; h < NH; h++) {
      const x1 = hx3[h] * cyw + hz3[h] * syw;
      const z1 = hz3[h] * cyw - hx3[h] * syw;
      const y2 = hy3[h] * cp - z1 * sp;
      hdep[h] = hy3[h] * sp + z1 * cp;
      hpx[h] = cx + x1 * R;
      hpy[h] = cy - y2 * R;
    }

    const RR = R * R;
    for (let k = 0; k < NA * (ASEG + 1); k++) {
      const o = k * 3;
      const x1 = arc3[o] * cyw + arc3[o + 2] * syw;
      const z1 = arc3[o + 2] * cyw - arc3[o] * syw;
      const y2 = arc3[o + 1] * cp - z1 * sp;
      const z2 = arc3[o + 1] * sp + z1 * cp;
      const sx = cx + x1 * R,
        sy = cy - y2 * R;
      apx[k] = sx;
      apy[k] = sy;
      const dx = sx - cx,
        dy = sy - cy;
      /* 背面且落在球盘内 = 被球体遮挡;抬升段越过球缘则可见 */
      avis[k] = z2 > 0 || dx * dx + dy * dy > RR ? 1 : 0;
    }

    /* 原版鼠标推斥回归(改令③,参数与洛伦兹版一致:半径 160 / 力 90 平方衰减)。
       陆点/枢纽/弧样点同场位移保持连贯;放在 avis 判定之后——遮挡按未变形几何判,免得弧线在凹陷边缘闪断。 */
    if (!coarse && mouse.x > -9000) {
      const mx = mouse.x,
        my = mouse.y;
      const shove = (xs: Float32Array, ys: Float32Array, n: number) => {
        for (let i = 0; i < n; i++) {
          const ddx = xs[i] - mx;
          const ddy = ys[i] - my;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= 1 && d2 < 25600) {
            const d = Math.sqrt(d2);
            const f = 90 * (1 - d / 160) ** 2;
            xs[i] += (ddx / d) * f;
            ys[i] += (ddy / d) * f;
          }
        }
      };
      shove(px, py, N);
      shove(hpx, hpy, NH);
      shove(apx, apy, NA * (ASEG + 1));
    }

    /* 正交投影圆点盖章:亮度=深度光照(正面亮、背面 22% 渐隐保体积),12 档 sprite */
    bctx.globalCompositeOperation = 'source-over';
    bctx.fillStyle = '#000000';
    bctx.fillRect(0, 0, W, H);
    for (let i = 0; i < N; i++) {
      const m = dep[i];
      const s = m >= 0 ? 0.26 + 0.74 * m : 0.22 * (1 + m);
      if (s < 0.045) continue;
      const b = Math.min(SHB - 1, (s * SHB) | 0);
      const r = q * (1.15 + 0.65 * (m > 0 ? m : 0));
      bctx.drawImage(dotSprites[b], px[i] - r, py[i] - r, r + r, r + r);
    }

    /* R32→R47:辉光烘焙去抖。全画布 blur(7px) 是重渲帧的最大单项,滚动逐帧烘会把帧率
       拖到 43fps(无头实测);改 180ms 节流——滚动中辉光最多滞后 180ms(14% 透明度的模糊层,
       运动中不可感),停稳由 frame() 补烘一次保证终态一致(glowStale 位)。 */
    const tNow = performance.now();
    if (tNow - glowAt > 180) bakeGlow(tNow);
    else glowStale = true;
  };
  const bakeGlow = (tNow: number) => {
    /* 点阵比线网稀,叠加透明度略抬(0.10→0.14),R33 克制原则不变 */
    gctx.clearRect(0, 0, W, H);
    gctx.filter = 'blur(7px)';
    gctx.globalAlpha = 0.14;
    gctx.drawImage(body, 0, 0, W, H);
    gctx.filter = 'none';
    gctx.globalAlpha = 1;
    glowAt = tNow;
    glowStale = false;
  };

  /* 流光:12 档预乘衰减色(R34 技法沿用,黑底不透明覆盖零增亮) HUE-GUARD:comet (225, 255, 150) */
  const CB = 12,
    TAILU = 0.3;
  const cometStyles = Array.from({ length: CB }, (_, k) => {
    const fade = 1 - (k + 0.5) / CB;
    const a = fade * fade * 0.88;
    return `rgb(${Math.round(225 * a)},${Math.round(255 * a)},${Math.round(150 * a)})`;
  });

  interface Flight {
    a: number;
    t0: number;
    dur: number;
    rev: boolean;
    pinged: boolean;
  }
  interface Ring {
    h: number;
    t0: number;
  }
  const FL = coarse ? 6 : 14; /* 同时活跃流光条数(改令① + R47.4 二次加密:算力繁忙感) */
  const flights: Flight[] = [];
  const rings: Ring[] = [];
  const nextPing = new Float64Array(NH);
  let deck: number[] = [];
  /* 弧轮换:洗牌队列顺序消费,跑完一轮重洗——避免固定顺序的机械感 */
  const drawDeck = (): number => {
    if (!deck.length) deck = Array.from({ length: NA }, (_, i) => i).sort(() => Math.random() - 0.5);
    return deck.pop()!;
  };
  const launch = (t: number, delay: number): Flight => {
    const a = drawDeck();
    /* 时长随弧角长:短跳 ~1.6s,跨洋 ~3.5s(速度观感一致) */
    return { a, t0: t + delay, dur: 1600 + 1400 * (arcAng[a] / 1.6), rev: Math.random() < 0.5, pinged: false };
  };

  const P0 = { x: 0, y: 0, vis: false },
    PM = { x: 0, y: 0, vis: false },
    P1 = { x: 0, y: 0, vis: false };
  const arcAt = (a: number, u: number, out: { x: number; y: number; vis: boolean }) => {
    const s = Math.max(0, Math.min(1, u)) * ASEG;
    const i = Math.min(ASEG - 1, s | 0),
      f = s - i;
    const k = a * (ASEG + 1) + i;
    out.x = apx[k] + (apx[k + 1] - apx[k]) * f;
    out.y = apy[k] + (apy[k + 1] - apy[k]) * f;
    out.vis = !!(avis[k] && avis[k + 1]);
  };

  /* 网络层(每帧;still=静帧模式:reduced-motion / 暂停——枢纽常亮不呼吸、弧画静态基线、无流光无 ping) */
  const drawNet = (t: number, still: boolean) => {
    nctx.globalCompositeOperation = 'source-over';
    nctx.fillStyle = '#000000';
    nctx.fillRect(0, 0, W, H);
    nctx.lineCap = 'round';
    nctx.lineJoin = 'round';

    if (!still) {
      /* 到达即触发终点扩散环(「算力到达」),尾巴流尽后换下一条弧 */
      for (let i = 0; i < flights.length; i++) {
        const F = flights[i];
        const e = (t - F.t0) / F.dur;
        if (!F.pinged && e >= 1) {
          F.pinged = true;
          const target = F.rev ? ARCS_ALL[F.a][0] : ARCS_ALL[F.a][1];
          if (hdep[target] > 0) rings.push({ h: target, t0: t });
        }
        if (e >= 1 + TAILU) flights[i] = launch(t, 140 + Math.random() * 360);
      }
    }

    /* R48.13 主人令「所有节点同时连线」:全部弧常亮基线(此前只画在飞的 FL 条,网显得稀);
       still 静帧同画全网;被球体遮挡段断笔,背半球天然剔除 */
    nctx.lineWidth = Math.max(0.8, 0.9 * q);
    nctx.strokeStyle = 'rgb(52,68,13)';
    for (let a = 0; a < NA; a++) {
      nctx.beginPath();
      let pen = false;
      for (let k = 0; k <= ASEG; k++) {
        const o = a * (ASEG + 1) + k;
        if (!avis[o]) {
          pen = false;
          continue;
        }
        if (!pen) {
          nctx.moveTo(apx[o], apy[o]);
          pen = true;
        } else nctx.lineTo(apx[o], apy[o]);
      }
      nctx.stroke();
    }

    if (!still) {
      nctx.lineWidth = Math.max(1.1, 1.3 * q);
      for (const F of flights) {
        const e = (t - F.t0) / F.dur;
        if (e <= 0) continue;
        for (let k = 0; k < CB; k++) {
          let u1 = e - (TAILU * k) / CB;
          let u0 = e - (TAILU * (k + 1)) / CB;
          if (u1 <= 0 || u0 >= 1) continue;
          u0 = Math.max(0, u0);
          u1 = Math.min(1, u1);
          const a0 = F.rev ? 1 - u0 : u0,
            a1 = F.rev ? 1 - u1 : u1;
          arcAt(F.a, a0, P0);
          arcAt(F.a, (a0 + a1) / 2, PM);
          arcAt(F.a, a1, P1);
          if (!P0.vis || !P1.vis) continue;
          nctx.strokeStyle = cometStyles[k];
          nctx.beginPath();
          nctx.moveTo(P0.x, P0.y);
          nctx.lineTo(PM.x, PM.y);
          nctx.lineTo(P1.x, P1.y);
          nctx.stroke();
        }
      }
    }

    /* 枢纽:呼吸辉光 + 核心;周期 2.8–3.6s、相位按序错开(确定性,不同步呼吸) */
    for (let h = 0; h < NH; h++) {
      if (hdep[h] < -0.02) continue;
      const af = Math.max(0, Math.min(1, (hdep[h] + 0.02) * 8)); /* 贴球缘淡入淡出 */
      const pul = still ? 0.5 : 0.5 + 0.5 * Math.sin((t / (2800 + ((h * 37) % 9) * 100)) * 2 * Math.PI + h * 2.4);
      const hr = q * (9 + 3.5 * pul) * haloR[h];
      nctx.globalAlpha = af * (0.3 + 0.34 * pul) * haloA[h];
      nctx.drawImage(hubHalo, hpx[h] - hr, hpy[h] - hr, hr + hr, hr + hr);
      const cr = q * 2.6;
      nctx.globalAlpha = af * (0.85 + 0.15 * pul);
      nctx.drawImage(hubCore, hpx[h] - cr, hpy[h] - cr, cr + cr, cr + cr);
      nctx.globalAlpha = 1;
      if (!still && t >= nextPing[h]) {
        if (hdep[h] > 0) rings.push({ h, t0: t });
        nextPing[h] = t + 5000 + Math.random() * 3000;
      }
    }

    /* 扩散环:3→14px 淡出 0.9s;跟随枢纽实时位置(滚动中不脱锚) */
    if (!still && rings.length) {
      nctx.lineWidth = Math.max(1, 1.1 * q);
      for (let i = rings.length - 1; i >= 0; i--) {
        const g = rings[i];
        const e = (t - g.t0) / 900;
        if (e >= 1 || hdep[g.h] <= 0) {
          rings.splice(i, 1);
          continue;
        }
        const rr = q * (3 + 11 * e);
        const a = (1 - e) * (1 - e) * 0.55;
        nctx.strokeStyle = `rgb(${Math.round(190 * a)},${Math.round(245 * a)},${Math.round(52 * a)})`;
        nctx.beginPath();
        nctx.arc(hpx[g.h], hpy[g.h], rr, 0, Math.PI * 2);
        nctx.stroke();
      }
    }

    ctx.drawImage(net, 0, 0, W, H); /* ctx 处于 screen 模式,黑底无效果 */
  };

  /* 静帧合成(reduced-motion 初绘 / 暂停态 / resize 重画共用) */
  const drawStatic = () => {
    const P = poseHome();
    renderBody(P.cx, P.cy, P.r, HOME_YAW, P.pitch);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(glow, 0, 0, W, H);
    ctx.drawImage(body, 0, 0, W, H);
    drawNet(0, true);
  };

  let raf = 0;
  let running = false;
  const frame = () => {
    const now = performance.now();
    /* 常转:dt 封顶 100ms——切页/长任务归来球不瞬移 */
    const dt = lastT < 0 ? 16 : Math.min(100, now - lastT);
    lastT = now;
    const sy = window.scrollY;
    const dsy = lastSy < 0 ? 0 : sy - lastSy;
    lastSy = sy;
    spinYaw += SPIN * dt + Math.max(-KICK_CAP, Math.min(KICK_CAP, dsy * SCROLL_K));
    let P = poseHome();
    const ps = [prog(anchors[0]), prog(anchors[1]), prog(anchors[2], 0.35), prog(anchors[3])];
    P = mix(P, poseA(), ps[0]);
    P = mix(P, poseB(), ps[1]);
    P = mix(P, poseC(), ps[2]);
    P = mix(P, poseD(), ps[3]);

    if (!coarse && mouse.x > -9000) {
      const ex = (mouse.x - 0.5 * W) / (0.5 * W);
      const ey = (mouse.y - 0.5 * H) / (0.5 * H);
      driftX += (-8 * ex - driftX) * 0.035;
      driftY += (-8 * ey - driftY) * 0.035;
      tiltX += (0.04 * ex - tiltX) * 0.035;
      tiltY += (0.03 * ey - tiltY) * 0.035;
      if (Math.abs(-8 * ex - driftX) < 0.15) driftX = -8 * ex;
      if (Math.abs(-8 * ey - driftY) < 0.15) driftY = -8 * ey;
      if (Math.abs(0.04 * ex - tiltX) < 1.5e-3) tiltX = 0.04 * ex;
      if (Math.abs(0.03 * ey - tiltY) < 1e-3) tiltY = 0.03 * ey;
    } else {
      driftX *= 0.96;
      driftY *= 0.96;
      tiltX *= 0.96;
      tiltY *= 0.96;
      if (Math.abs(driftX) < 0.15) driftX = 0;
      if (Math.abs(driftY) < 0.15) driftY = 0;
      if (Math.abs(tiltX) < 1.5e-3) tiltX = 0;
      if (Math.abs(tiltY) < 1e-3) tiltY = 0;
    }

    const cx = P.cx + driftX;
    const cy = P.cy + driftY;
    const yaw = spinYaw + tiltX;
    const pitch = P.pitch + tiltY;

    dbg.yaw = yaw;
    dbg.pitch = pitch;
    dbg.r = P.r;
    dbg.fl = FL;
    dbg.tiltX = tiltX;
    dbg.tiltY = tiltY;
    dbg.driftX = driftX;
    dbg.driftY = driftY;

    if (
      dirty ||
      Math.abs(P.r - rR) > 1e-3 ||
      Math.abs(cx - rCx) > 0.3 ||
      Math.abs(cy - rCy) > 0.3 ||
      Math.abs(yaw - rYaw) > 1e-4 ||
      Math.abs(pitch - rPitch) > 1e-4
    ) {
      renderBody(cx, cy, P.r, yaw, pitch);
      dirty = false;
      rR = P.r;
      rCx = cx;
      rCy = cy;
      rYaw = yaw;
      rPitch = pitch;
    } else if (glowStale) {
      bakeGlow(now); /* 滚动停稳:主体没再动,把节流欠下的辉光补齐到终态 */
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(glow, 0, 0, W, H);
    ctx.drawImage(body, 0, 0, W, H);
    drawNet(now, false);

    if (running) raf = requestAnimationFrame(frame);
  };

  /* 用户按了暂停就不再自启(标签切回来触发的 visibilitychange 也不能把它带起来)。
     存储读写都包 try:隐私模式 / 禁用站点数据时 localStorage 会直接抛。 */
  const PAUSE_KEY = 'x-bg-paused';
  let userPaused = false;
  try {
    userPaused = localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    /* 存储不可用:按未暂停处理 */
  }
  const start = () => {
    if (running || reduced || userPaused) return;
    running = true;
    lastT = -1; /* 停摆期不计入自转 */
    lastSy = -1; /* 停摆期的滚动位移不折算成旋转 */
    if (!flights.length) {
      const t = performance.now();
      for (let i = 0; i < FL; i++) flights.push(launch(t, 250 + i * 450));
      for (let h = 0; h < NH; h++) nextPing[h] = t + 1500 + h * 420;
    }
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  resize();
  anchors = ANCHOR_IDS.map((id) => document.getElementById(id));
  addEventListener('resize', resize);
  if (!coarse) {
    addEventListener(
      'mousemove',
      (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      },
      { passive: true },
    );
    document.documentElement.addEventListener('mouseleave', () => {
      mouse.x = -9999;
      mouse.y = -9999;
    });
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  document.addEventListener('x:bg-pause', (e) => {
    userPaused = (e as CustomEvent<boolean>).detail === true;
    try {
      localStorage.setItem(PAUSE_KEY, userPaused ? '1' : '0');
    } catch {
      /* 同上 */
    }
    if (userPaused) {
      stop();
      drawStatic();
    } else start();
  });

  if (reduced) {
    drawStatic();
    return;
  }
  if (userPaused) {
    drawStatic(); // 上次就是暂停态:画一帧静帧,不起循环
    return;
  }
  start();
}

/* ---------- ② Lenis(duration 1.2 + easeOutExpo,恒定收尾时长) ---------- */
function initLenis() {
  if (reduced) return;
  const lenis = new Lenis({
    duration: 1.2,
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  });
  lenisInst = lenis;
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  document.addEventListener('click', (e) => {
    /* R45:修饰键 / 非主键 / 已被处理的点击放行原生语义(Ctrl+click 开新标签等) */
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!a) return;
    const id = a.getAttribute('href')!.slice(1);
    const el = id && document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    /* R43:此前写死 84(屏幕量),而 [id]{scroll-margin-top} 是画布量、会随画布缩,
       两者在 >=1440 分家 16px —— 点击站内链接后目标标题被导航条压住(实测净空 -16.1px)。
       改为实测导航条高度,单位天然一致。 */
    const navH = document.querySelector('.site-nav')?.getBoundingClientRect().height ?? 0;
    lenis.scrollTo(el.getBoundingClientRect().top + window.scrollY - navH - 10);
    // hash 没变就不 push:连点同一个锚点曾让 history 每次 +1(与原生片段导航口径不同,back 要按 N 次)
    if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    /* R45:原生片段导航会把键盘焦点起点移到目标,补间版也要——否则点完 Tab 又回到导航 */
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
    el.focus({ preventScroll: true });
  });
  return lenis;
}

/* ---------- ⑨ 证书放大(R44 · R45 锁滚) ----------
   原生 <dialog>:Esc 关闭、焦点管理、背景遮罩由浏览器负责;开启键是 <a href=大图>,无 JS 直接打开图片。
   R45:灯箱开着时 Lenis 仍吃滚轮去滚页面 → 打开即 stop、关闭即 start;dialog 自带 data-lenis-prevent 让滚轮进灯箱。 */
function initCertZoom() {
  const dlg = document.querySelector<HTMLDialogElement>('.cert-zoom');
  const img = dlg?.querySelector('img') as HTMLImageElement | null;
  if (!dlg || !img) return;
  for (const btn of document.querySelectorAll<HTMLAnchorElement>('.cert-open')) {
    btn.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 修饰键放行:新标签打开原件(与锚点处理器同口径)
      if (typeof dlg.showModal !== 'function') return; // 无 <dialog> 的老浏览器:不拦默认动作,走 <a href> 原生打开
      e.preventDefault();
      img.removeAttribute('src'); // 先清上一张:盒子由 width/height 属性撑住,慢网首开不弹小白框、也不闪上一张
      img.src = btn.dataset.src ?? btn.href;
      if (btn.dataset.srcset) img.srcset = btn.dataset.srcset;
      img.alt = btn.dataset.alt ?? '';
      dlg.classList.add('is-loading'); // 慢网下大图要几秒,先给个加载态
      const settle = () => dlg.classList.remove('is-loading');
      if (img.complete) settle();
      else {
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
      }
      dlg.showModal();
      dlg.scrollTop = 0; // 必须在 showModal 之后:关闭态 dialog 无盒,赋值无效(重开曾残留上次滚动位)
      dlg.scrollLeft = 0;
      scrollLock(true); // 连 documentElement 的 overflow 一起管(计数式,见 scrollLock)
    });
  }
  dlg.addEventListener('close', () => scrollLock(false));
  dlg.addEventListener('click', (e) => {
    // 点背景关闭:按几何判「点在对话框盒子之外」——e.target===dlg 会把对话框自己的内衬带也当背景(点左缘 5px 即关)
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}

/* ---------- ③ 行遮罩逐行上滑(display 标题;P1-01) ---------- */
function initLineReveal() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-lr]')];
  if (!els.length) return;
  if (reduced) {
    for (const el of els) el.classList.add('lr-ready');
    return;
  }

  const splitWords = (text: string, lang: string): string[] => {
    if (lang.startsWith('zh') && 'Segmenter' in Intl) {
      const seg = new (Intl as unknown as { Segmenter: new (l: string, o: object) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter('zh', { granularity: 'word' });
      return [...seg.segment(text)].map((s) => s.segment);
    }
    return text.split(/(\s+)/).filter((s) => s.length);
  };

  /* 每个宿主一份状态:原文(重建要用)、是否已播(播完已还原成纯文本,重建无意义)、在途的观察器/定时器 */
  type LR = { original: string; played: boolean; io?: IntersectionObserver; timer?: number };
  const st = new Map<HTMLElement, LR>();

  const build = (el: HTMLElement) => {
    const s: LR = st.get(el) ?? { original: el.textContent ?? '', played: false };
    st.set(el, s);
    const original = s.original;
    const plainH = el.offsetHeight; // 拆行前的高度:动画期锁住,版面零位移
    const lang = document.documentElement.lang || 'en';
    // 词包 span → 按 rect.top 归行
    el.textContent = '';
    const words = splitWords(original, lang);
    const spans = words.map((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      if (!/^\s+$/.test(w)) s.style.display = 'inline-block';
      el.appendChild(s);
      return s;
    });
    const lines: HTMLSpanElement[][] = [];
    let lastTop = -1e9;
    for (const s of spans) {
      // R42:空白块保持 inline(行盒高),词块是 inline-block(内容盒高),两者 rect.top 实测差 7px,
      // 超过 2px 阈值 ⇒ 每个空白开一新「行」、其后每个词再开一新「行」,标题被裂成「一词一行」的词梯。
      // 实测后果:首屏标题载入后 2.4 秒内高 531px(应 212px),33 路由 75 个标题全中。
      // 空白不参与归行判定,跟着前一行走即可。
      if (/^\s+$/.test(s.textContent || '')) {
        if (lines.length) lines[lines.length - 1].push(s);
        continue;
      }
      const top = Math.round(s.getBoundingClientRect().top);
      if (Math.abs(top - lastTop) > 2) {
        lines.push([]);
        lastTop = top;
      }
      lines[lines.length - 1].push(s);
    }
    /* 词块量完行就改回 inline:inline-block 在 <1 行高下会把行盒撑高,拆行/复原各一次布局位移(vi 首页 CLS 的主因) */
    for (const s of spans) s.style.display = '';
    el.textContent = '';
    /* R45:可访问文本走视觉隐藏节点(aria-label 在 div/p 这类无角色宿主上是 ARIA 禁止用法) */
    const sr = document.createElement('span');
    sr.className = 'x-sr';
    sr.textContent = original.trim();
    el.appendChild(sr);
    const inners: HTMLElement[] = [];
    for (let li = 0; li < lines.length; li++) {
      const outer = document.createElement('span');
      outer.className = 'lr-line';
      outer.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('span');
      inner.className = 'lr-inner';
      /* 首屏(load 模式)逐行错拍 176ms 对齐参考站实测的 176.5;正文块保持 90 ——
         参考站正文是逐行独立触发、错拍随滚速浮动(实测 50–150),我方固定值反而更稳。 */
      inner.style.setProperty('--lrd', `${li * (el.dataset.lr === 'load' ? 176 : 90)}ms`);
      for (const s of lines[li]) inner.appendChild(s);
      outer.appendChild(inner);
      el.appendChild(outer);
      inners.push(inner);
    }
    el.classList.add('lr-ready'); // 遮罩已建,宿主可见(内层仍在 110% 处,被 overflow 遮住)
    if (Math.abs(el.offsetHeight - plainH) > 0.5) el.style.height = `${plainH}px`; // 拆行盒子高度与纯文本不一致时锁高
    const play = () => {
      s.played = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          inners.forEach((n) => {
            n.classList.add('in');
            n.parentElement?.classList.add('lr-open'); // 起滑同帧放开下边余量(等待期遮死,见 tokens.css)
          }),
        ),
      );
      const last = inners[inners.length - 1];
      const restore = () => {
        if (el.textContent === original) return;
        el.textContent = original; // 还原原始文本(a11y/选中/SEO 一致性)
        el.style.height = '';
      };
      last.addEventListener('transitionend', restore, { once: true });
      /* 过渡被取消(播放中切「减少动态」/ 打印 / 祖先被隐藏)时 transitionend 永不到达,
         标题会永久停在拆行态;取消事件 + 总时长兜底各补一道 */
      last.addEventListener('transitioncancel', restore, { once: true });
      /* 步进要按本档的真值取:滚动档 90ms、开场档 176ms。写死 90 时,四行及以上的开场标题
         兜底会早于实际收尾(n=4 实测兜底 1370ms vs 收尾 1428ms),把最后一行提前拍回纯文本。 */
      const stepMs = el.dataset.lr === 'load' ? 176 : 90;
      s.timer = window.setTimeout(restore, stepMs * (inners.length - 1) + 900 + 200);
    };
    const mode = el.dataset.lr;
    /* 开场钟的延迟只属于首页开场(html.x-boot);刷新 / 后退 / 带锚点进来时不排队、建好即播——
       否则标题成了整屏最后出现的元素(实测刷新时 565ms 才起滑,导航与副题早已就位) */
    const delay = document.documentElement.classList.contains('x-boot') ? Number(el.dataset.lrDelay || 0) : 0;
    if (mode === 'load') {
      /* R45:标题拍锚在开场钟(boot+delay),不再是「字体就绪 + delay」——慢字体下曾漂到副题拍之后 */
      s.timer = window.setTimeout(play, Math.max(0, BEAT_T0 + delay - performance.now()));
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            s.timer = window.setTimeout(play, delay);
          }
        },
        { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
      );
      s.io = io;
      io.observe(el);
    }
  };

  /* 未播放的宿主按当前字形与当前宽度重拆:视口变了(旋转 / 拖窗 / 缩放)旧行组就是过期的,
     字体在兜底到点之后才落地时,拆行是按回退字形量的(行数可能差一行) */
  const rebuild = (el: HTMLElement) => {
    const s = st.get(el);
    if (!s || s.played) return; // 播完已是纯文本,浏览器自己重排
    s.io?.disconnect();
    clearTimeout(s.timer);
    el.textContent = s.original;
    el.style.height = '';
    el.classList.remove('lr-ready');
    build(el);
  };
  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => els.forEach(rebuild), 200);
  });

  /* 每个标题只等自己那档字重**和自己那串字**(Mega 500:首屏标题与页脚字标;其余 400),不等 fonts.ready:
     等两档曾让 vi 慢网首屏标题跟着 400 子集晚到 1.4s;不带文本则只等含空格的那个子集(vi 叠音符子集不在内)。
     兜底必须早于副题拍,标题才一定先到;兜底后到的字体由上面的 rebuild 接手 */
  /* 兜底同样锚在 BEAT_T0(与副题的 CSS 拍同钟),不是「从现在起 N 毫秒」——
     后者在慢网下会跟着 fx 的到达一起顺延,而副题拍不会,于是 vi 的标题排到副题后面(实测晚 0.67s)。
     🔴 400 是从副题拍倒推的,不是随手取的:tokens.css 里 .hero .sub 的 animation-delay 是 0.55s,
        兜底必须小于它。改那一拍必须同步改这里 —— R46 把副题拍从 1.4s 提到 0.55s 时,
        原来的 600 就已经晚于副题拍了(慢字体下标题会反过来排在副题后面)。 */
  const cap = new Promise<void>((r) => setTimeout(r, Math.max(0, BEAT_T0 + 400 - performance.now())));
  for (const el of els) {
    const cs = getComputedStyle(el);
    const key = `${cs.fontWeight} 16px ${cs.fontFamily}`;
    const load = document.fonts ? document.fonts.load(key, el.textContent ?? '').catch(() => undefined) : Promise.resolve(undefined);
    Promise.race([load, cap]).then(() => build(el));
  }
  if (document.fonts) document.fonts.ready.then(() => els.forEach(rebuild));
}

/* ---------- ④ 打字机(mono 眉标/编号;P1-02 · R45 影子层) ----------
   注册:原文放进 visibility:hidden 的影子层定版面(折行/宽度/内衬全部与终态一致),
   打字层叠在同一格子里逐字填;结束还原纯文本。CJK/chip/右对齐不再需要任何宽度预留。 */
function initType() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-tw]')];
  if (!els.length) return;
  if (reduced) {
    for (const el of els) el.classList.add('tw-done');
    return;
  }
  const zh = (document.documentElement.lang || '').startsWith('zh');
  const prep = (el: HTMLElement) => {
    const text = el.textContent ?? '';
    const inline = getComputedStyle(el).display === 'inline';
    const sr = document.createElement('span');
    sr.className = 'x-sr';
    sr.textContent = text;
    const ghost = document.createElement('span');
    ghost.className = 'tw-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = text;
    const live = document.createElement('span');
    live.className = 'tw-live';
    live.setAttribute('aria-hidden', 'true');
    el.replaceChildren(sr, ghost, live);
    el.classList.add('tw', inline ? 'tw-inline' : 'tw-block');
    return { text, live };
  };
  const run = (el: HTMLElement, text: string, live: HTMLElement) => {
    const speed = Number(el.dataset.twSpeed || (zh ? 90 : 50));
    let i = 0;
    const iv = setInterval(() => {
      i++;
      live.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(iv);
        el.textContent = text; // 终态 === i18n 原文,影子/打字层全部拆除
        el.classList.remove('tw', 'tw-inline', 'tw-block');
        el.classList.add('tw-done');
      }
    }, speed);
  };
  for (const el of els) {
    const { text, live } = prep(el);
    const delay = Number(el.dataset.twDelay || 0);
    const go = () => setTimeout(() => run(el, text, live), delay);
    if (el.dataset.tw === 'load') {
      go();
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            go();
          }
        },
        { threshold: 0.1 },
      );
      io.observe(el);
    }
  }
}

/* ---------- ⑤ 次要块 reveal(P1-03:阈值 .05/底-20px) ---------- */
/* 背景暂停键(WCAG 2.2.2 A 级)。键在页脚,状态存 localStorage,跨页保持。 */
function initBgToggle() {
  const btn = document.querySelector<HTMLButtonElement>('[data-bg-toggle]');
  if (!btn) return;
  let paused = false;
  try { paused = localStorage.getItem('x-bg-paused') === '1'; } catch { /* 存储不可用 */ }
  const render = () => {
    btn.textContent = paused ? btn.dataset.labelPlay ?? '' : btn.dataset.labelPause ?? '';
    btn.setAttribute('aria-pressed', String(paused));
  };
  render();
  btn.addEventListener('click', () => {
    paused = !paused;
    render();
    document.dispatchEvent(new CustomEvent('x:bg-pause', { detail: paused }));
  });
}

function initReveal() {
  const els = document.querySelectorAll<HTMLElement>('[data-rv]');
  if (!els.length || reduced) return;
  /* 引擎到得比 CSS 兜底还晚:兜底已经把这些块显出来了,再走一遍进场等于先闪一下再消失,直接落终态。
     阈值**从 CSS 读**(--x-rv-fallback),不再在这里另写一个 3000 —— 原来两处各写一个、
     靠注释「改一处必须改另一处」约束,而那正是应该焊成单一真源的写法。 */
  const fb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--x-rv-fallback')) || 3000;
  if (performance.now() - BEAT_T0 > fb) {
    for (const el of els) el.classList.add('in', 'rv-done');
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement;
        el.classList.add('in');
        /* R45:进场结束后加 .rv-done,把过渡时长/延迟交还给元素自己的规则(hover 0.2s 曾被 0.9s+延迟接管) */
        const done = () => el.classList.add('rv-done');
        /* 指针停着不动、元素滑到手下:hover 样式先于本事件生效,已开始的 0.9s 过渡改不了时长——
           把当前透明度钉成内联值再放开,强制过渡从当前值按 0.2s 重启 */
        const doneNow = () => {
          if (el.classList.contains('rv-done')) return;
          el.style.opacity = getComputedStyle(el).opacity;
          done();
          requestAnimationFrame(() => {
            el.style.opacity = '';
          });
        };
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target !== el) return;
          el.removeEventListener('transitionend', onEnd);
          done();
        };
        el.addEventListener('transitionend', onEnd);
        el.addEventListener('pointerenter', doneNow, { once: true }); // 光标已停在元素上时进场:hover 的 0.2s 不必等 0.9s 走完
        setTimeout(done, 1600); // 兜底:过渡被打断/元素不可见时也要交还
        io.unobserve(el);
      }
    },
    { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
  );
  els.forEach((el) => io.observe(el));
}

/* ---------- ⑥ 设备 deck:画布几何连续推进(R8) ----------
   机制:滚动总程 = N×区高,拍 k 占 [k/N,(k+1)/N];
   卡 i 位移 = STEP·(i − Σ_{k<i}beats)(STEP=1.0923 卡宽),缩放 = 1−0.15·beats[i];
   末态全叠于锚位(高序号在上);透明深带(.band-deep,R48 前身是白幕布 .band-light)在 decked 时
   上拉一个区高盖过钉屏尾段——带子透明后「遮挡」由叠卡在重叠段自淡出承担(见 apply 末段)。 */
function initPile() {
  const sec = document.querySelector<HTMLElement>('[data-deck]');
  const pin = sec?.querySelector<HTMLElement>('[data-deck-pin]') ?? null;
  const cards = sec ? [...sec.querySelectorAll<HTMLElement>('[data-deck-card]')] : [];
  const band = document.querySelector<HTMLElement>('.band-deep');
  if (!sec || !pin || !cards.length) return;
  const engaged = () => !reduced && !coarse && !matchMedia('(max-width: 860px)').matches;
  let active = false;

  const PARK = 0.85;
  const N = cards.length;
  let ZOOM = 1;
  let STEP = 0,
    DIST = 0;
  const measure = () => {
    const pinH = pin.offsetHeight; // = --x-sec-h(与参考站钉屏区同角色);画布单位
    STEP = Math.round(cards[0].offsetWidth * 1.0923); // 步距=1.0923 卡宽(710/650,间隙 9.23%);画布单位
    /* R42:页面套了画布壳(zoom),于是「布局单位」与「屏幕单位」不再等价 ——
       offsetHeight / style.height 是画布单位,getBoundingClientRect 是屏幕单位。
       推进量拿 rect 算,故 DIST 必须换算到屏幕单位,否则编舞跑得快一个缩放倍数、提前收完。
       zoom 直接由「同一元素的两种读数之比」得出,不依赖 CSS 变量。 */
    ZOOM = pin.getBoundingClientRect().height / (pinH || 1) || 1;
    DIST = N * pinH * ZOOM; // 每拍一个区高(屏幕单位)
    sec.style.height = `${(N + 1) * pinH}px`; // 画布单位(它是 CSS 长度,住在画布内)
  };
  const clear = () => {
    sec.classList.remove('decked');
    band?.classList.remove('curtain');
    sec.style.height = '';
    pin.style.opacity = '';
    for (const c of cards) c.style.transform = '';
  };
  const smooth = (t: number) => t * t * (3 - 2 * t); // smoothstep(P2-22)
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  let raf = 0;
  const apply = () => {
    raf = 0;
    if (!active) return;
    // R42:钉屏区在高屏上垂直居中(sticky top = T),推进量必须同步平移 —— 否则先有一段
    // 「钉住但什么都不发生」的死区,末段编舞又发生在钉屏区已开始上移、幕布已盖上之后
    // (实测 1440 高屏:336px 死区 + 末卡只收到 0.90 而非 0.85)。
    const T = (parseFloat(getComputedStyle(pin).top) || 0) * ZOOM; // CSS 值是画布单位,换算到屏幕单位
    const secTop = sec.getBoundingClientRect().top;
    const e = clamp01((T - secTop) / DIST);
    /* R48:深带透明后,curtain 重叠段的「遮挡」改由叠卡自淡出承担(白幕布时代靠不透明底)。
       带顶从 DIST−secH 处开始压进钉屏区、到 DIST 处盖满 —— 重叠窗与**最后一拍同期**
       (白幕布时代最后一拍本来就在幕布底下播完,不可见;淡出让这段等价)。
       0.8 让卡在盖满前略提前隐没,不与压上来的新区内容叠影。 */
    const secH = pin.offsetHeight * ZOOM || 1;
    const o = smooth(clamp01((T - secTop - (DIST - secH)) / (secH * 0.8)));
    pin.style.opacity = o > 0 ? (1 - o).toFixed(3) : '';
    const beats: number[] = [];
    for (let k = 0; k < N; k++) beats.push(smooth(clamp01((e - k / N) * N)));
    for (let i = 0; i < N; i++) {
      let done = 0;
      for (let k = 0; k < i; k++) done += beats[k];
      const x = Math.max(0, STEP * (i - done));
      const s = 1 - (1 - PARK) * beats[i];
      cards[i].style.transform = `translate3d(${x.toFixed(1)}px, 0, 0) scale(${s.toFixed(4)})`;
    }
  };
  const engage = () => {
    const want = engaged();
    if (want && !active) {
      active = true;
      sec.classList.add('decked');
      band?.classList.add('curtain');
      /* R45:停放在屏外的卡被 .x-frame 的裁切框挡住 lazy 预取,滑入时整张白框;桌面编舞在离叠卡区一屏半时预取(不在首载就拉 1MB) */
      const imgs = [...sec.querySelectorAll<HTMLImageElement>('img')];
      const pre = new IntersectionObserver(
        ([en]) => {
          if (!en.isIntersecting) return;
          pre.disconnect();
          for (const img of imgs) img.loading = 'eager';
        },
        { rootMargin: '150% 0px' },
      );
      pre.observe(sec);
      measure();
      apply();
    } else if (!want && active) {
      active = false;
      clear();
    } else if (want && active) {
      measure();
      apply();
    }
  };
  engage();
  addEventListener('resize', engage);
  addEventListener(
    'scroll',
    () => {
      if (active && !raf) raf = requestAnimationFrame(apply);
    },
    { passive: true },
  );
}

/* ---------- ⑦ 三列滚动视差(反白卡区;P1-28) ---------- */
function initParallax() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-plx]')];
  if (!els.length || reduced || coarse) return;
  let raf = 0;
  /* 已写进 transform 的位移(画布量)。必须记账:getBoundingClientRect() 读到的 top 里**已经含着它**,
     不减掉就成了递归定义 —— 每帧只走 1/(1+k) 的距离,而 apply() 只挂在 scroll/resize/focusin 上,
     瞬时滚动(锚点直达、刷新恢复)只触发一次,于是永久冻在半路。 */
  const written = new WeakMap<HTMLElement, number>();
  const apply = () => {
    raf = 0;
    if (matchMedia('(max-width: 850px)').matches) {
      for (const el of els) {
        el.style.transform = '';
        written.delete(el);
      }
      return;
    }
    const vh2 = innerHeight / 2;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const k = Number(el.dataset.plx || 0.08);
      /* R43:dy 由 rect(屏幕量)算出,却写进画布内元素的 transform(画布量),渲染时再乘一次 zoom
         ⇒ >=1440 位移超出 1.333 倍。除以缩放换算回画布量。同族第三处(前两处在叠卡编舞里已修)。 */
      const zx = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
      /* 减掉上一帧写进去的那一份(记账值是画布量,渲染时被 zoom 放大 zx 倍才进 rect) */
      const shift = (written.get(el) ?? 0) * (zx || 1);
      const dy = ((vh2 - (r.top - shift + r.height / 2)) * k) / (zx || 1);
      written.set(el, dy);
      el.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
    }
  };
  apply();
  addEventListener(
    'scroll',
    () => {
      if (!raf) raf = requestAnimationFrame(apply);
    },
    { passive: true },
  );
  addEventListener('resize', apply);
  /* 键盘 Tab 进视差层:浏览器按**旧位移**把元素滚进视口,随后视差重算又把它挪走(实测焦点件落到视口下方 300px)。
     重算完再把焦点件对到视口中间。 */
  addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest('[data-plx]')) return;
    if (!t.matches(':focus-visible')) return; // 只管键盘路径:鼠标点半露卡片里的链接不该被瞬移居中
    apply();
    requestAnimationFrame(() => {
      const r = t.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= innerHeight) return;
      const y = scrollY + r.top - innerHeight / 2 + r.height / 2;
      if (lenisInst) lenisInst.scrollTo(y, { immediate: true });
      else scrollTo(0, y);
    });
  });
}

/* ---------- ⑧ UTC 时钟(秒奇偶冒号,锁墙钟秒;P1-11) ---------- */
function initClock() {
  const el = document.getElementById('x-clock');
  if (!el) return;
  const h12 = document.createElement('span');
  const mm = document.createElement('span');
  const ap = document.createElement('span');
  const colon = document.createElement('span');
  colon.className = 'colon';
  colon.textContent = ':';
  el.replaceChildren('UTC\u00a0', h12, colon, mm, '\u00a0', ap); // 宿主是 inline-flex:裸空格文本节点成匿名 flex 项后不渲染(曾显示 UTC07:13PM),必须 NBSP
  const tick = () => {
    const d = new Date();
    let h = d.getUTCHours();
    ap.textContent = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    h12.textContent = String(h).padStart(2, '0');
    mm.textContent = String(d.getUTCMinutes()).padStart(2, '0');
    colon.style.opacity = d.getUTCSeconds() % 2 === 0 ? '1' : '0'; // 2s 周期方波
  };
  tick();
  setTimeout(() => {
    tick();
    setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000)); // 相位锁墙钟秒
}

/* ---------- ⑩ 导航字符扰动 hover(R10):悬停即扰动、左→右每 4 帧定格一字 ----------
   字池按文种分:拉丁→A-Z、数字→0-9、CJK→基础笔画(一丨丿丶乛十),
   空格/标点不动 → 宽度稳定不跳版;中文不闪随机汉字(避免乱码感,笔画=「字在组装」)。
   移开立即还原;按下取消(点击瞬间文本必须稳定);reduced/无 hover 设备不挂。 */
function initScramble() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-scr]')];
  if (!els.length || reduced || !matchMedia('(hover: hover)').matches) return;
  const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIG = '0123456789';
  const CJK = '一丨丿丶乛十';
  const isCjk = (ch: string) => /[㐀-鿿豈-﫿]/.test(ch);
  const pick = (pool: string) => pool[Math.floor(Math.random() * pool.length)];
  const scrambleChar = (ch: string) => {
    if (/\s/.test(ch)) return ch;
    if (isCjk(ch)) return pick(CJK);
    if (/[0-9]/.test(ch)) return pick(DIG);
    if (/[A-Za-zÀ-ỹ]/.test(ch)) return pick(LAT);
    return ch; // 标点/符号不扰动
  };
  for (const el of els) {
    const original = el.textContent ?? '';
    if (!original.trim()) continue;
    const chars = [...original]; // 码点级拆分(vi 声调字 NFC 单码点,安全)
    el.setAttribute('aria-label', original.trim());
    let raf = 0;
    let frame = 0;
    const stop = (restore: boolean) => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (restore) el.textContent = original;
    };
    const run = () => {
      const settled = Math.min(Math.floor(frame / 4), chars.length);
      el.textContent = chars.map((c, i) => (i < settled ? c : scrambleChar(c))).join('');
      frame++;
      if (settled < chars.length) raf = requestAnimationFrame(run);
      else raf = 0;
    };
    el.addEventListener('mouseenter', () => {
      stop(false);
      frame = 0;
      raf = requestAnimationFrame(run);
    });
    el.addEventListener('mouseleave', () => stop(true));
    el.addEventListener('pointerdown', () => stop(true));
  }
}

/* ---------- boot ---------- */
const boot = () => {
  const html = document.documentElement;
  html.classList.add('js'); // 兜底;正常由 Base.astro 头部内联脚本在首帧前加(no-JS 防隐形闸,P2-09)
  setVw();
  addEventListener('resize', setVw);
  document.addEventListener('x:scroll-lock', () => scrollLock(true));
  document.addEventListener('x:scroll-unlock', () => scrollLock(false));

  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => initGlobe(), { timeout: 800 });
  } else {
    setTimeout(initGlobe, 200);
  }
  initLenis();
  initLineReveal();
  initCertZoom();
  initType();
  initReveal();
  initBgToggle();
  initClock();
  initPile();
  initParallax();
  initScramble();

  /* R48.7:开场编排收官后整只摘掉 x-boot —— fill 态动画会让挂它的祖先永久成为 backdrop root,
     子孙的 backdrop-filter 采样面被切空(第一案 .site-nav 磨砂、第二案 #stats 玻璃带,均实测)。
     规则层已全改 backwards,这里把类摘掉让「x-boot 只存在于开场窗口」成为结构事实,同族永绝。
     2.6s = 最晚 CSS 拍(0.55s 延迟 + 0.5s 时长,锚点首帧)+ 余量;JS 拍只在注册时读该类,不受影响。 */
  if (html.classList.contains('x-boot')) {
    setTimeout(() => html.classList.remove('x-boot'), Math.max(0, BEAT_T0 + 2600 - performance.now()));
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
