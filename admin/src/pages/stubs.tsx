/* 模块占位页:每个导航项都有真页面(非死链);功能面按包序交付。
   占位内容=该模块做什么 + 规格锚点 + 当前草稿概览里的相关计数(真数据,不是摆设)。 */
import { useShell } from '../shell';

function Stub(props: { title: string; con: string; pkg: string; desc: string; extra?: React.ReactNode }) {
  return (
    <section>
      <h2>{props.title}</h2>
      <div className="note info">
        {props.desc}
        <div className="kv" style={{ marginTop: 6 }}>规格:官网后台 PRD [{props.con}] · 交付批次:{props.pkg}</div>
      </div>
      {props.extra}
    </section>
  );
}

export function DashboardStub() {
  const { overview } = useShell();
  return (
    <Stub
      title="驾驶舱"
      con="FEAT-CON03"
      pkg="包⑧"
      desc="流量/转化/内容榜/质量/屏蔽统计看板。数据采集(包②)已上线在积累原始事件;看板界面在包⑧交付,届时读的就是现在攒下的数。"
      extra={
        overview && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginTop: 12 }}>
            <div className="card"><h3>线上版本</h3><div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>v{overview.liveVersion}</div></div>
            <div className="card"><h3>未发布改动</h3><div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{overview.dirty}</div></div>
            <div className="card"><h3>草稿更新于</h3><div className="kv" style={{ fontSize: 14 }}>{new Date(overview.draft.updatedAt).toLocaleString('zh-CN', { hour12: false })}</div></div>
          </div>
        )
      }
    />
  );
}

export const ContentStub = () => (
  <Stub title="文案树" con="FEAT-CON04" pkg="包⑤" desc="18 组三语文案并排编辑,缺译红旗、禁用词即时拦截。后端草稿/校验接口已就绪(包③),编辑界面在包⑤交付。" />
);
export const DownloadsStub = () => (
  <Stub title="下载入口" con="FEAT-CON05" pkg="包⑤" desc="iOS/Android/Web App 三入口的 URL 与上下架。站侧已改由配置驱动(包③),表单界面在包⑤交付。" />
);
export const StatsStub = () => (
  <Stub title="平台统计数字" con="FEAT-CON06" pkg="包⑤" desc="官网五个平台数字与口径月;等于旧演示值时软警告(R49-A2 真值化)。界面在包⑤交付。" />
);
export const SkusStub = () => (
  <Stub title="产品卡" con="FEAT-CON07" pkg="包⑥" desc="设备阶梯卡片的三语标语/排序/显隐;产品事实字段高敏。界面在包⑥交付。" />
);
export const FaqStub = () => (
  <Stub title="FAQ" con="FEAT-CON08" pkg="包⑥" desc="FAQ 条目增删改排(至少保留 3 条可见),发布后站上问答与结构化数据自动跟随。界面在包⑥交付。" />
);
export const AnnouncementStub = () => (
  <Stub title="公告条" con="FEAT-CON09" pkg="包⑥" desc="站顶限时公告:三语文案+链接+起止时间,到点自动下线。界面在包⑥交付。" />
);
export const SeoStub = () => (
  <Stub title="SEO 与页脚" con="FEAT-CON10" pkg="包⑥" desc="6 页 title/description 三语与页脚社媒/联系邮箱。校验器已发现现网 6 条超长(包⑤⑥上线后此处可改)。" />
);
export const LegalStub = () => (
  <Stub title="Legal" con="FEAT-CON11" pkg="包⑥" desc="条款/隐私/App 隐私三份法务文本(Markdown 粘贴+预览;高敏发布)。界面在包⑥交付。" />
);
export const GeoStub = () => (
  <Stub title="区域屏蔽" con="FEAT-CON12" pkg="包⑦" desc="按国家屏蔽访问(默认仅中国大陆,港澳台不连带)+ 拦截统计;自锁保护(后台不受屏蔽+管理员直通)。整包在包⑦交付。" />
);
export const PublishStub = () => (
  <Stub title="发布与版本" con="FEAT-CON13" pkg="包⑨" desc="把草稿改动过全部机器门后上线;门红保旧版;版本历史一键回滚。版本表已在记录(包③),流水线与界面在包⑨交付。" />
);
