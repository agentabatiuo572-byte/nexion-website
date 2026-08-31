/* ISO 3166-1 alpha-2 全集(代码+中文名),供区域屏蔽多选(CON12-③:select 枚举不手输)。
   紧凑串存储省体积;解析为 {code,name}[]。CN 不含 HK/MO/TW(独立代码)。 */
const RAW =
  'AD安道尔|AE阿联酋|AF阿富汗|AG安提瓜和巴布达|AI安圭拉|AL阿尔巴尼亚|AM亚美尼亚|AO安哥拉|AQ南极洲|AR阿根廷|AS美属萨摩亚|AT奥地利|AU澳大利亚|AW阿鲁巴|AX奥兰群岛|AZ阿塞拜疆|' +
  'BA波黑|BB巴巴多斯|BD孟加拉国|BE比利时|BF布基纳法索|BG保加利亚|BH巴林|BI布隆迪|BJ贝宁|BL圣巴泰勒米|BM百慕大|BN文莱|BO玻利维亚|BQ荷兰加勒比区|BR巴西|BS巴哈马|BT不丹|BV布韦岛|BW博茨瓦纳|BY白俄罗斯|BZ伯利兹|' +
  'CA加拿大|CC科科斯群岛|CD刚果(金)|CF中非|CG刚果(布)|CH瑞士|CI科特迪瓦|CK库克群岛|CL智利|CM喀麦隆|CN中国大陆|CO哥伦比亚|CR哥斯达黎加|CU古巴|CV佛得角|CW库拉索|CX圣诞岛|CY塞浦路斯|CZ捷克|' +
  'DE德国|DJ吉布提|DK丹麦|DM多米尼克|DO多米尼加|DZ阿尔及利亚|' +
  'EC厄瓜多尔|EE爱沙尼亚|EG埃及|EH西撒哈拉|ER厄立特里亚|ES西班牙|ET埃塞俄比亚|' +
  'FI芬兰|FJ斐济|FK福克兰群岛|FM密克罗尼西亚|FO法罗群岛|FR法国|' +
  'GA加蓬|GB英国|GD格林纳达|GE格鲁吉亚|GF法属圭亚那|GG根西|GH加纳|GI直布罗陀|GL格陵兰|GM冈比亚|GN几内亚|GP瓜德罗普|GQ赤道几内亚|GR希腊|GS南乔治亚|GT危地马拉|GU关岛|GW几内亚比绍|GY圭亚那|' +
  'HK香港|HM赫德岛|HN洪都拉斯|HR克罗地亚|HT海地|HU匈牙利|' +
  'ID印度尼西亚|IE爱尔兰|IL以色列|IM马恩岛|IN印度|IO英属印度洋领地|IQ伊拉克|IR伊朗|IS冰岛|IT意大利|' +
  'JE泽西|JM牙买加|JO约旦|JP日本|' +
  'KE肯尼亚|KG吉尔吉斯斯坦|KH柬埔寨|KI基里巴斯|KM科摩罗|KN圣基茨和尼维斯|KP朝鲜|KR韩国|KW科威特|KY开曼群岛|KZ哈萨克斯坦|' +
  'LA老挝|LB黎巴嫩|LC圣卢西亚|LI列支敦士登|LK斯里兰卡|LR利比里亚|LS莱索托|LT立陶宛|LU卢森堡|LV拉脱维亚|LY利比亚|' +
  'MA摩洛哥|MC摩纳哥|MD摩尔多瓦|ME黑山|MF法属圣马丁|MG马达加斯加|MH马绍尔群岛|MK北马其顿|ML马里|MM缅甸|MN蒙古|MO澳门|MP北马里亚纳|MQ马提尼克|MR毛里塔尼亚|MS蒙特塞拉特|MT马耳他|MU毛里求斯|MV马尔代夫|MW马拉维|MX墨西哥|MY马来西亚|MZ莫桑比克|' +
  'NA纳米比亚|NC新喀里多尼亚|NE尼日尔|NF诺福克岛|NG尼日利亚|NI尼加拉瓜|NL荷兰|NO挪威|NP尼泊尔|NR瑙鲁|NU纽埃|NZ新西兰|' +
  'OM阿曼|' +
  'PA巴拿马|PE秘鲁|PF法属波利尼西亚|PG巴布亚新几内亚|PH菲律宾|PK巴基斯坦|PL波兰|PM圣皮埃尔和密克隆|PN皮特凯恩|PR波多黎各|PS巴勒斯坦|PT葡萄牙|PW帕劳|PY巴拉圭|' +
  'QA卡塔尔|' +
  'RE留尼汪|RO罗马尼亚|RS塞尔维亚|RU俄罗斯|RW卢旺达|' +
  'SA沙特阿拉伯|SB所罗门群岛|SC塞舌尔|SD苏丹|SE瑞典|SG新加坡|SH圣赫勒拿|SI斯洛文尼亚|SJ斯瓦尔巴|SK斯洛伐克|SL塞拉利昂|SM圣马力诺|SN塞内加尔|SO索马里|SR苏里南|SS南苏丹|ST圣多美和普林西比|SV萨尔瓦多|SX荷属圣马丁|SY叙利亚|SZ斯威士兰|' +
  'TC特克斯和凯科斯|TD乍得|TF法属南部领地|TG多哥|TH泰国|TJ塔吉克斯坦|TK托克劳|TL东帝汶|TM土库曼斯坦|TN突尼斯|TO汤加|TR土耳其|TT特立尼达和多巴哥|TV图瓦卢|TW台湾|TZ坦桑尼亚|' +
  'UA乌克兰|UG乌干达|UM美国本土外小岛屿|US美国|UY乌拉圭|UZ乌兹别克斯坦|' +
  'VA梵蒂冈|VC圣文森特和格林纳丁斯|VE委内瑞拉|VG英属维尔京|VI美属维尔京|VN越南|VU瓦努阿图|' +
  'WF瓦利斯和富图纳|WS萨摩亚|' +
  'YE也门|YT马约特|' +
  'ZA南非|ZM赞比亚|ZW津巴布韦';

export const ISO_COUNTRIES: Array<{ code: string; name: string }> = RAW.split('|').map((s) => ({
  code: s.slice(0, 2),
  name: s.slice(2),
}));
export const countryName = (code: string): string => ISO_COUNTRIES.find((c) => c.code === code)?.name ?? code;
