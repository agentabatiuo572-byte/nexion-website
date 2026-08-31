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

export const PublishStub = () => (
  <Stub title="发布与版本" con="FEAT-CON13" pkg="包⑨" desc="把草稿改动过全部机器门后上线;门红保旧版;版本历史一键回滚。版本表已在记录(包③),流水线与界面在包⑨交付。" />
);
