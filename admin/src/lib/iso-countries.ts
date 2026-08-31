/* 控制台侧再导出——国家表单源在 schema 包(服务端 PUT 校验同 import),
   避免「面板挡得住、API 挡不住」的两套判据(2026-08-31 第二路验收 P2)。 */
export { ISO_COUNTRIES, countryName, SENTINEL_COUNTRY, isRealCountryCode } from '../../../schema/src/countries';
