// node --import ./register-ts-ext.mjs <script> —— 站内 TS 是打包器风格无后缀 import,
// 补一个「相对路径找不到就试 +.ts」的解析钩子,让种子/等价门能直跑站 TS 模块。
import { register } from 'node:module';
register('./ts-ext-resolver.mjs', import.meta.url);
