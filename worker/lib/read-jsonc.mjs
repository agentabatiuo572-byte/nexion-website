/* JSONC(带注释的 JSON)读取器 —— wrangler.jsonc 的唯一解析入口。
   为什么要单独一个文件:同一份配置此前有两个消费面各读各的
   (`gate-config-consistency` 用正则剥注释后 JSON.parse,`test-static` 直接正则抠字段),
   两边对「什么是合法 JSONC」的理解不一样,于是同一次改动只会咬到其中一边。

   🔴 用扫描器而不是正则,因为**正则判不出「这个斜杠在不在字符串里」**:
   - 剥块注释的那条正则会把 URL 里带块注释记号的路径连内容一起吃掉;
   - 剥行注释的那条只认独占一行的写法,`"key": 1, // 说明` 这种 wrangler 完全接受的
     写法会让 JSON.parse 当场崩(实测崩过一次)。
   逐字符走一遍,带一个「现在在不在字符串里」的状态,这两类问题就都不存在了。
   (顺带一记:上一版这段注释里直接写出了块注释的结束记号,把自己这段注释提前关掉了。) */

/** 剥掉注释与尾随逗号,返回可交给 JSON.parse 的文本;字符串字面量内的一切原样保留。 */
export function stripJsonc(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    // 行注释:吃到行尾(保留换行,让 JSON.parse 的错误行号仍然对得上)
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // 块注释:吃到 */;把其中的换行补回去,同样是为了错误行号
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i + 2, end < 0 ? src.length : end);
      out += body.replace(/[^\n]/g, '');
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    /* 尾随逗号:JSONC 允许 `[1, 2,]`,JSON.parse 不允许。
       只在字符串外生效——字符串内容是整段写进 out 的,它的最后一个非空白字符
       是闭引号而不是逗号,所以不会被这里误删。 */
    if (c === '}' || c === ']') {
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && out[j] === ',') out = out.slice(0, j) + out.slice(j + 1);
    }
    out += c;
    i++;
  }
  return out;
}

/** 解析 JSONC 文本;失败时把原始报错和位置一并抛出(门要能说清"读不动"是读不动在哪) */
export function parseJsonc(text, label = 'JSONC') {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const m = /position (\d+)/.exec(String(e));
    const near = m ? stripped.slice(Math.max(0, Number(m[1]) - 60), Number(m[1]) + 60).replace(/\s+/g, ' ') : '';
    throw new Error(`${label} 解析失败:${String(e).slice(0, 120)}${near ? `\n  出错处附近:…${near}…` : ''}`);
  }
}
