-- FEAT-ANTIBOT01 §3.5:AI 反爬闸事件日汇总(按日 × 判定 × 原因)。
-- hits = 事件条数(节流后下限);enforced_hits = 其中真正执行拦截/挑战的条数(monitor 下为 0)。
CREATE TABLE daily_gate (
  date TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  enforced_hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, verdict, reason)
);
